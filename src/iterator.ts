import { decodeInternalKey, encodeInternalKey, ValueType, type SequenceNumber } from './types.js';
import type { Comparator } from './comparator.js';

export interface IterLike {
  valid(): boolean;
  key(): Buffer;
  value(): Buffer;
  next(): Promise<void> | void;
  prev(): Promise<void> | void;
  seekToFirst(): Promise<void> | void;
  seekToLast(): Promise<void> | void;
  seek(target: Buffer): Promise<void> | void;
}

type LazyChildFactory = () => Promise<IterLike[]>;

interface HeapEntry {
  iter: IterLike;
  key: Buffer;
}

export class Iterator implements AsyncDisposable {
  private children: IterLike[];
  private lazyFactories: LazyChildFactory[] = [];
  private resolved = false;
  private heap: HeapEntry[] = [];
  private cmp: Comparator;
  private lastUserKey: Buffer | null = null;
  private snapshot: SequenceNumber | null;

  constructor(
    children: IterLike[],
    lazyFactories: LazyChildFactory[],
    cmp: Comparator,
    snapshot?: SequenceNumber,
  ) {
    this.children = children;
    this.lazyFactories = lazyFactories;
    this.cmp = cmp;
    this.snapshot = snapshot ?? null;
  }

  private async ensureChildren(): Promise<void> {
    if (this.resolved) return;
    for (const factory of this.lazyFactories) {
      const newChildren = await factory();
      this.children.push(...newChildren);
    }
    this.lazyFactories = [];
    this.resolved = true;
  }

  async seekToFirst(): Promise<void> {
    await this.ensureChildren();
    this.heap = [];
    for (const child of this.children) {
      await child.seekToFirst();
      if (child.valid()) {
        this.heap.push({ iter: child, key: child.key() });
      }
    }
    this.lastUserKey = null;
    this.heapify();
    await this.skipDuplicates();
  }

  async seekToLast(): Promise<void> {
    await this.ensureChildren();
    this.heap = [];
    for (const child of this.children) {
      await child.seekToLast();
      if (child.valid()) {
        this.heap.push({ iter: child, key: child.key() });
      }
    }
    this.lastUserKey = null;
    this.heapifyReverse();
    await this.skipDuplicatesReverse();
  }

  async seek(target: Buffer): Promise<void> {
    await this.ensureChildren();
    const seekSeq = this.snapshot ?? 0xffffffffffffffffn as SequenceNumber;
    const ikey = encodeInternalKey(target, seekSeq, ValueType.Value);
    this.heap = [];
    for (const child of this.children) {
      await child.seek(ikey);
      if (child.valid()) {
        this.heap.push({ iter: child, key: child.key() });
      }
    }
    this.lastUserKey = null;
    this.heapify();
    await this.skipDuplicates();
  }

  async next(): Promise<void> {
    if (this.heap.length === 0) return;
    const entry = this.heap[0];
    this.lastUserKey = decodeInternalKey(entry.key).userKey;
    await entry.iter.next();
    if (entry.iter.valid()) {
      entry.key = entry.iter.key();
      this.siftDown(0);
    } else {
      this.heapPop();
    }
    await this.skipDuplicates();
  }

  async prev(): Promise<void> {
    if (this.heap.length === 0) return;
    const entry = this.heap[0];
    this.lastUserKey = decodeInternalKey(entry.key).userKey;
    await entry.iter.prev();
    if (entry.iter.valid()) {
      entry.key = entry.iter.key();
      this.siftDownReverse(0);
    } else {
      this.heapPopReverse();
    }
    await this.skipDuplicatesReverse();
  }

  valid(): boolean {
    return this.heap.length > 0;
  }

  key(): Buffer {
    return decodeInternalKey(this.heap[0].key).userKey;
  }

  value(): Buffer {
    return this.heap[0].iter.value();
  }

  close(): void {
    this.heap = [];
    this.children = [];
    this.lazyFactories = [];
    this.resolved = false;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<{ key: Buffer; value: Buffer }> {
    await this.seekToFirst();
    while (this.valid()) {
      yield { key: this.key(), value: this.value() };
      await this.next();
    }
  }

  private heapify(): void {
    for (let i = Math.floor(this.heap.length / 2) - 1; i >= 0; i--) {
      this.siftDown(i);
    }
  }

  private siftDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.comp(this.heap[left].key, this.heap[smallest].key) < 0) {
        smallest = left;
      }
      if (right < n && this.comp(this.heap[right].key, this.heap[smallest].key) < 0) {
        smallest = right;
      }
      if (smallest === i) break;
      [this.heap[i], this.heap[smallest]] = [this.heap[smallest], this.heap[i]];
      i = smallest;
    }
  }

  private heapPop(): void {
    if (this.heap.length <= 1) {
      this.heap.pop();
      return;
    }
    this.heap[0] = this.heap.pop()!;
    this.siftDown(0);
  }

  // Max-heap helpers (for reverse iteration — largest InternalKey at top)
  private heapifyReverse(): void {
    for (let i = Math.floor(this.heap.length / 2) - 1; i >= 0; i--) {
      this.siftDownReverse(i);
    }
  }

  private siftDownReverse(i: number): void {
    const n = this.heap.length;
    while (true) {
      let largest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.comp(this.heap[left].key, this.heap[largest].key) > 0) largest = left;
      if (right < n && this.comp(this.heap[right].key, this.heap[largest].key) > 0) largest = right;
      if (largest === i) break;
      [this.heap[i], this.heap[largest]] = [this.heap[largest], this.heap[i]];
      i = largest;
    }
  }

  private heapPopReverse(): void {
    if (this.heap.length <= 1) {
      this.heap.pop();
      return;
    }
    this.heap[0] = this.heap.pop()!;
    this.siftDownReverse(0);
  }

  private comp(a: Buffer, b: Buffer): number {
    return this.cmp.compare(a, b);
  }

  private async skipDuplicates(): Promise<void> {
    while (this.heap.length > 0) {
      const topKey = this.heap[0].key;
      const decoded = decodeInternalKey(topKey);

      // Skip entries newer than snapshot (fix: snapshot isolation)
      if (this.snapshot !== null && decoded.sequence > this.snapshot) {
        const entry = this.heap[0];
        await entry.iter.next();
        if (entry.iter.valid()) {
          entry.key = entry.iter.key();
          this.siftDown(0);
        } else {
          this.heapPop();
        }
        continue;
      }

      if (decoded.valueType === ValueType.Deletion) {
        this.lastUserKey = decoded.userKey;
        const entry = this.heap[0];
        await entry.iter.next();
        if (entry.iter.valid()) {
          entry.key = entry.iter.key();
          this.siftDown(0);
        } else {
          this.heapPop();
        }
        continue;
      }

      if (this.lastUserKey && Buffer.compare(decoded.userKey, this.lastUserKey) === 0) {
        const entry = this.heap[0];
        await entry.iter.next();
        if (entry.iter.valid()) {
          entry.key = entry.iter.key();
          this.siftDown(0);
        } else {
          this.heapPop();
        }
        continue;
      }

      break;
    }
  }

  private async skipDuplicatesReverse(): Promise<void> {
    while (this.heap.length > 0) {
      const topKey = this.heap[0].key;
      const decoded = decodeInternalKey(topKey);

      // Skip entries newer than snapshot
      if (this.snapshot !== null && decoded.sequence > this.snapshot) {
        const entry = this.heap[0];
        await entry.iter.prev();
        if (entry.iter.valid()) {
          entry.key = entry.iter.key();
          this.siftDownReverse(0);
        } else {
          this.heapPopReverse();
        }
        continue;
      }

      if (decoded.valueType === ValueType.Deletion) {
        this.lastUserKey = decoded.userKey;
        const entry = this.heap[0];
        await entry.iter.prev();
        if (entry.iter.valid()) {
          entry.key = entry.iter.key();
          this.siftDownReverse(0);
        } else {
          this.heapPopReverse();
        }
        continue;
      }

      if (this.lastUserKey && Buffer.compare(decoded.userKey, this.lastUserKey) === 0) {
        const entry = this.heap[0];
        await entry.iter.prev();
        if (entry.iter.valid()) {
          entry.key = entry.iter.key();
          this.siftDownReverse(0);
        } else {
          this.heapPopReverse();
        }
        continue;
      }

      break;
    }
  }
}
