import { Worker } from 'node:worker_threads';
import { VersionEdit } from '../version/version_edit.js';
import { VersionSet } from '../version/version_set.js';
import { TableBuilder } from '../sstable/table_builder.js';
import { Table } from '../sstable/table.js';
import { tableFileName } from '../sstable/filename.js';
import { BytewiseComparator } from '../comparator.js';
import type { Comparator } from '../comparator.js';
import { decodeInternalKey, type FileMetaData } from '../types.js';
import type { DBOptions } from '../options.js';
import type { WorkerResponse, WorkerRequest } from './worker.js';
import { statSync, unlinkSync, existsSync } from 'node:fs';

interface SourceIter {
  valid(): boolean;
  key(): Buffer;
  value(): Buffer;
  next(): Promise<void> | void;
  seekToFirst(): Promise<void> | void;
}

interface HeapEntry {
  iter: SourceIter;
  key: Buffer;
}

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

export class CompactionScheduler {
  private cmp: Comparator;
  private worker: Worker | null = null;

  constructor(
    private dbname: string,
    private options: Required<DBOptions>,
    private versions: VersionSet,
  ) {
    this.cmp = new BytewiseComparator();
  }

  /** Attach a Worker Thread for async compaction. */
  attachWorker(worker: Worker): void {
    this.worker = worker;
  }

  /** Detach and terminate the Worker Thread. */
  async detachWorker(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
  }

  /**
   * Check if compaction is needed and run it (synchronous fallback).
   */
  async maybeCompact(): Promise<boolean> {
    const current = this.versions.current();
    if (current.files(0).length > 4) {
      await this.compactLevel(0);
      return true;
    }
    return false;
  }

  /**
   * Check if compaction is needed and dispatch to Worker Thread.
   * Returns immediately; compaction runs asynchronously.
   */
  maybeCompactAsync(): boolean {
    if (!this.worker) return false;
    const current = this.versions.current();
    if (current.files(0).length > 4) {
      this.compactLevelAsync(0).catch(err => {
        console.error('[CompactionScheduler] Async compaction failed:', err);
      });
      return true;
    }
    return false;
  }

  /**
   * Synchronous merge-compaction (fallback when no Worker available).
   */
  async compactLevel(level: number): Promise<void> {
    const current = this.versions.current();
    const inputFiles = current.files(level);
    if (inputFiles.length === 0) return;

    const sources: FileMetaData[] = level === 0 ? [...inputFiles] : [inputFiles[0]];
    const outputLevel = level + 1;
    const outputFiles = current.files(outputLevel);

    let minKey = sources[0].smallest;
    let maxKey = sources[0].largest;
    for (const f of sources) {
      if (Buffer.compare(f.smallest, minKey) < 0) minKey = f.smallest;
      if (Buffer.compare(f.largest, maxKey) > 0) maxKey = f.largest;
    }

    const overlapping: FileMetaData[] = [];
    for (const f of outputFiles) {
      if (Buffer.compare(f.largest, minKey) >= 0 && Buffer.compare(f.smallest, maxKey) <= 0) {
        overlapping.push(f);
      }
    }

    const allInputs = [...sources, ...overlapping];
    const tables: Table[] = [];
    const children: SourceIter[] = [];

    for (const f of allInputs) {
      const fn = tableFileName(this.dbname, f.fileNumber);
      if (!existsSync(fn)) continue;
      const table = await Table.open(fn);
      tables.push(table);
      children.push(table.iterator(this.cmp));
    }

    if (children.length === 0) return;

    const outputFileNumber = this.versions.allocateFileNumber();
    const outputPath = tableFileName(this.dbname, outputFileNumber);
    const builder = new TableBuilder(outputPath, this.options);
    const internalCmp = makeInternalKeyComparator(this.cmp);

    const heap: HeapEntry[] = [];
    for (const child of children) {
      await child.seekToFirst();
      if (child.valid()) heap.push({ iter: child, key: child.key() });
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
        await builder.add(key, value);
        lastKey = key;
      }

      await top.iter.next();
      if (top.iter.valid()) {
        top.key = top.iter.key();
        siftDown(heap, 0, internalCmp);
      } else {
        heapPop(heap, internalCmp);
      }
    }

    await builder.finish();

    if (!outputSmallest || !outputLargest) return;

    const fileSize = statSync(outputPath).size;
    const meta: FileMetaData = {
      fileNumber: outputFileNumber,
      fileSize,
      smallest: outputSmallest,
      largest: outputLargest,
    };

    const edit = this.versions.newVersionEdit();
    for (const f of sources) {
      edit.deleteFile(level, f.fileNumber);
      const oldPath = tableFileName(this.dbname, f.fileNumber);
      if (existsSync(oldPath)) unlinkSync(oldPath);
    }
    for (const f of overlapping) {
      edit.deleteFile(outputLevel, f.fileNumber);
      const oldPath = tableFileName(this.dbname, f.fileNumber);
      if (existsSync(oldPath)) unlinkSync(oldPath);
    }
    edit.addFile(outputLevel, meta);
    await this.versions.logAndApply(edit);
  }

  /**
   * Async compaction via Worker Thread.
   * Sends a DoCompaction message and returns when the worker completes.
   */
  async compactLevelAsync(level: number): Promise<void> {
    if (!this.worker) {
      return this.compactLevel(level);
    }

    const current = this.versions.current();
    const inputFiles = current.files(level);
    if (inputFiles.length === 0) return;

    const sources: FileMetaData[] = level === 0 ? [...inputFiles] : [inputFiles[0]];
    const outputLevel = level + 1;
    const outputFiles = current.files(outputLevel);

    let minKey = sources[0].smallest;
    let maxKey = sources[0].largest;
    for (const f of sources) {
      if (Buffer.compare(f.smallest, minKey) < 0) minKey = f.smallest;
      if (Buffer.compare(f.largest, maxKey) > 0) maxKey = f.largest;
    }

    const overlapping: FileMetaData[] = [];
    for (const f of outputFiles) {
      if (Buffer.compare(f.largest, minKey) >= 0 && Buffer.compare(f.smallest, maxKey) <= 0) {
        overlapping.push(f);
      }
    }

    const outputFileNumber = this.versions.allocateFileNumber();

    const request: WorkerRequest = {
      type: 'DoCompaction',
      dbname: this.dbname,
      sources: sources.map(f => ({ fileNumber: f.fileNumber, level })),
      overlapping: overlapping.map(f => ({ fileNumber: f.fileNumber, level: outputLevel })),
      outputFileNumber,
      outputLevel,
      options: this.options,
    };

    // Post to Worker and wait for response
    const response = await new Promise<WorkerResponse>((resolve, reject) => {
      const handler = (msg: WorkerResponse | { type: string; message?: string }) => {
        if (msg.type === 'CompactionDone') {
          this.worker!.off('message', handler);
          resolve(msg as WorkerResponse);
        } else if (msg.type === 'Error') {
          this.worker!.off('message', handler);
          reject(new Error((msg as { message: string }).message));
        }
      };
      this.worker!.on('message', handler);
      this.worker!.postMessage(request);
    });

    if (response.fileSize === 0) return;

    const meta: FileMetaData = {
      fileNumber: outputFileNumber,
      fileSize: response.fileSize,
      smallest: Buffer.from(response.smallest, 'hex'),
      largest: Buffer.from(response.largest, 'hex'),
    };

    const edit = this.versions.newVersionEdit();
    for (const f of sources) {
      edit.deleteFile(level, f.fileNumber);
      const oldPath = tableFileName(this.dbname, f.fileNumber);
      if (existsSync(oldPath)) unlinkSync(oldPath);
    }
    for (const f of overlapping) {
      edit.deleteFile(outputLevel, f.fileNumber);
      const oldPath = tableFileName(this.dbname, f.fileNumber);
      if (existsSync(oldPath)) unlinkSync(oldPath);
    }
    edit.addFile(outputLevel, meta);
    await this.versions.logAndApply(edit);
  }
}
