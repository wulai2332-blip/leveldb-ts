// Worker Thread entry point for compaction.
// This file is loaded by Worker Threads via new Worker().
// Handles two message types:
//   CompactMemtable — build SSTable from raw key/value pairs
//   DoCompaction   — merge multiple SSTables into one

import { parentPort } from 'node:worker_threads';
import { TableBuilder } from '../sstable/table_builder.js';
import { Table } from '../sstable/table.js';
import { tableFileName } from '../sstable/filename.js';
import { BytewiseComparator } from '../comparator.js';
import type { Comparator } from '../comparator.js';
import { decodeInternalKey, type FileMetaData } from '../types.js';
import type { DBOptions } from '../options.js';
import { statSync, existsSync } from 'node:fs';

export interface CompactMemtableRequest {
  type: 'CompactMemtable';
  dbname: string;
  entries: { key: string; value: string }[];
  fileNumber: number;
  options: Required<DBOptions>;
}

export interface DoCompactionRequest {
  type: 'DoCompaction';
  dbname: string;
  sources: { fileNumber: number; level: number }[];
  overlapping: { fileNumber: number; level: number }[];
  outputFileNumber: number;
  outputLevel: number;
  options: Required<DBOptions>;
}

export type WorkerRequest = CompactMemtableRequest | DoCompactionRequest;

export interface WorkerResponse {
  type: 'CompactionDone';
  fileNumber: number;
  fileSize: number;
  smallest: string;
  largest: string;
}

export interface WorkerError {
  type: 'Error';
  message: string;
}

// SourceIter for merging
interface SourceIter {
  valid(): boolean;
  key(): Buffer;
  value(): Buffer;
  next(): void;
  seekToFirst(): void;
}

interface HeapEntry {
  iter: SourceIter;
  key: Buffer;
}

// InternalKey comparator
function makeInternalKeyComparator(userCmp: Comparator): Comparator {
  return {
    name: () => 'leveldb.InternalKeyComparator',
    compare: (a: Buffer, b: Buffer) => {
      const dA = decodeInternalKey(a);
      const dB = decodeInternalKey(b);
      const r = userCmp.compare(dA.userKey, dB.userKey);
      if (r !== 0) return r;
      if (dA.sequence > dB.sequence) return -1;
      if (dA.sequence < dB.sequence) return 1;
      return 0;
    },
    findShortestSeparator: () => Buffer.alloc(0),
    findShortSuccessor: () => Buffer.alloc(0),
  };
}

// Min-heap helpers
function siftDown(heap: HeapEntry[], i: number, cmp: Comparator): void {
  const n = heap.length;
  while (true) {
    let smallest = i;
    const left = 2 * i + 1;
    const right = 2 * i + 2;
    if (left < n && cmp.compare(heap[left].key, heap[smallest].key) < 0) smallest = left;
    if (right < n && cmp.compare(heap[right].key, heap[smallest].key) < 0) smallest = right;
    if (smallest === i) break;
    [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
    i = smallest;
  }
}

function heapPop(heap: HeapEntry[], cmp: Comparator): void {
  if (heap.length <= 1) { heap.pop(); return; }
  heap[0] = heap.pop()!;
  siftDown(heap, 0, cmp);
}

async function handleCompactMemtable(msg: CompactMemtableRequest): Promise<void> {
  const outputPath = tableFileName(msg.dbname, msg.fileNumber);
  const builder = new TableBuilder(outputPath, msg.options);

  let smallest: string | null = null;
  let largest: string | null = null;

  for (const { key, value } of msg.entries) {
    const keyBuf = Buffer.from(key, 'hex');
    const valBuf = Buffer.from(value, 'hex');
    if (!smallest) smallest = key;
    largest = key;
    builder.add(keyBuf, valBuf);
  }

  builder.finish();

  const fileSize = statSync(outputPath).size;
  parentPort?.postMessage({
    type: 'CompactionDone',
    fileNumber: msg.fileNumber,
    fileSize,
    smallest: smallest || '',
    largest: largest || '',
  } satisfies WorkerResponse);
}

async function handleDoCompaction(msg: DoCompactionRequest): Promise<void> {
  const cmp = new BytewiseComparator();
  const allInputs = [...msg.sources, ...msg.overlapping];
  const children: SourceIter[] = [];

  // Open all input tables with sync I/O (Worker has its own event loop)
  for (const f of allInputs) {
    const fn = tableFileName(msg.dbname, f.fileNumber);
    if (!existsSync(fn)) continue;
    const table = await Table.open(fn);
    children.push(table.iterator(cmp));
  }

  if (children.length === 0) {
    parentPort?.postMessage({
      type: 'CompactionDone',
      fileNumber: msg.outputFileNumber,
      fileSize: 0,
      smallest: '',
      largest: '',
    } satisfies WorkerResponse);
    return;
  }

  // Build merged output
  const outputPath = tableFileName(msg.dbname, msg.outputFileNumber);
  const builder = new TableBuilder(outputPath, msg.options);
  const internalCmp = makeInternalKeyComparator(cmp);

  // Seed heap
  const heap: HeapEntry[] = [];
  for (const child of children) {
    child.seekToFirst();
    if (child.valid()) {
      heap.push({ iter: child, key: child.key() });
    }
  }

  for (let i = Math.floor(heap.length / 2) - 1; i >= 0; i--) {
    siftDown(heap, i, internalCmp);
  }

  let outputSmallest: Buffer | null = null;
  let outputLargest: Buffer | null = null;
  let lastKey: Buffer | null = null;

  while (heap.length > 0) {
    const top = heap[0];
    const key = top.key;
    const value = top.iter.value();

    if (!lastKey || Buffer.compare(key, lastKey) !== 0) {
      if (!outputSmallest) outputSmallest = key;
      outputLargest = key;
      builder.add(key, value);
      lastKey = key;
    }

    top.iter.next();
    if (top.iter.valid()) {
      top.key = top.iter.key();
      siftDown(heap, 0, internalCmp);
    } else {
      heapPop(heap, internalCmp);
    }
  }

  builder.finish();

  const fileSize = statSync(outputPath).size;
  parentPort?.postMessage({
    type: 'CompactionDone',
    fileNumber: msg.outputFileNumber,
    fileSize,
    smallest: outputSmallest ? outputSmallest.toString('hex') : '',
    largest: outputLargest ? outputLargest.toString('hex') : '',
  } satisfies WorkerResponse);
}

parentPort?.on('message', async (msg: WorkerRequest) => {
  try {
    if (msg.type === 'CompactMemtable') {
      await handleCompactMemtable(msg);
    } else if (msg.type === 'DoCompaction') {
      await handleDoCompaction(msg);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort?.postMessage({ type: 'Error', message } satisfies WorkerError);
  }
});
