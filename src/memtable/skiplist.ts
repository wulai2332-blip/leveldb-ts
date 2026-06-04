import type { Comparator } from '../comparator.js';
import type { Arena } from '../arena.js';
import { Status } from '../status.js';

const kMaxHeight = 12;
const kBranching = 4;

export interface SkipListNode {
  key: Buffer;
  value: Buffer;
  next: (SkipListNode | null)[]; // next[0..height-1]
}

export class SkipListIterator {
  private node: SkipListNode | null = null;

  constructor(private list: SkipList) {}

  valid(): boolean {
    return this.node !== null;
  }

  key(): Buffer {
    return this.node!.key;
  }

  value(): Buffer {
    return this.node!.value;
  }

  next(): void {
    if (this.node) {
      this.node = this.node.next[0];
    }
  }

  prev(): void {
    if (!this.node) return;
    const prev = this.list.findLessThan(this.node.key);
    this.node = prev === this.list.head ? null : prev;
  }

  seek(key: Buffer): void {
    this.node = this.list.findGreaterOrEqual(key);
  }

  seekToFirst(): void {
    this.node = this.list.head.next[0];
  }

  seekToLast(): void {
    let n: SkipListNode = this.list.head;
    while (n.next[0]) n = n.next[0]!;
    this.node = n === this.list.head ? null : n;
  }

  status(): Status {
    return Status.ok();
  }
}

export class SkipList {
  readonly head: SkipListNode;
  private maxHeight = 1;
  private rngState = 0xdeadbeef;

  constructor(
    private cmp: Comparator,
    private arena: Arena
  ) {
    const next: (SkipListNode | null)[] = new Array(kMaxHeight);
    next.fill(null);
    this.head = { key: Buffer.alloc(0), value: Buffer.alloc(0), next };
  }

  insert(key: Buffer, value: Buffer): void {
    const prev = this.findPrev(key);
    // Allocate key/value copies from Arena to reduce GC pressure
    const keyCopy = this.arena.allocate(key.length);
    key.copy(keyCopy);
    const valueCopy = this.arena.allocate(value.length);
    value.copy(valueCopy);
    const node: SkipListNode = {
      key: keyCopy,
      value: valueCopy,
      next: new Array<SkipListNode | null>(this.randomHeight()).fill(null),
    };
    for (let i = 0; i < node.next.length; i++) {
      node.next[i] = prev[i].next[i];
      prev[i].next[i] = node;
    }
  }

  find(key: Buffer): { key: Buffer; value: Buffer } | null {
    const node = this.findGreaterOrEqual(key);
    if (node && this.cmp.compare(node.key, key) === 0) {
      return { key: node.key, value: node.value };
    }
    return null;
  }

  findLessThan(key: Buffer): SkipListNode {
    let x: SkipListNode = this.head;
    let level = this.maxHeight - 1;
    while (true) {
      const next = x.next[level];
      if (next !== null && this.cmp.compare(next.key, key) < 0) {
        x = next;
      } else {
        if (level === 0) return x;
        level--;
      }
    }
  }

  findGreaterOrEqual(key: Buffer): SkipListNode | null {
    let x = this.head;
    let level = this.maxHeight - 1;
    while (true) {
      const next = x.next[level];
      if (next && this.cmp.compare(next.key, key) < 0) {
        x = next;
      } else {
        if (level === 0) return next;
        level--;
      }
    }
  }

  iterator(): SkipListIterator {
    return new SkipListIterator(this);
  }

  private findPrev(key: Buffer): (SkipListNode)[] {
    const prev: SkipListNode[] = new Array(kMaxHeight);
    // Initialize all levels to head — levels above current maxHeight
    // will use head as prev (head.next[i] = null for those levels)
    for (let i = 0; i < kMaxHeight; i++) {
      prev[i] = this.head;
    }
    let x = this.head;
    for (let level = this.maxHeight - 1; level >= 0; level--) {
      while (x.next[level] && this.cmp.compare(x.next[level]!.key, key) < 0) {
        x = x.next[level]!;
      }
      prev[level] = x;
    }
    return prev;
  }

  private randomHeight(): number {
    let height = 1;
    while (height < kMaxHeight && this.randomOneIn(kBranching)) {
      height++;
    }
    if (height > this.maxHeight) {
      this.maxHeight = height;
    }
    return height;
  }

  private randomOneIn(n: number): boolean {
    // Simple xorshift
    this.rngState ^= this.rngState << 13;
    this.rngState ^= this.rngState >> 17;
    this.rngState ^= this.rngState << 5;
    return (this.rngState >>> 0) % n === 0;
  }
}
