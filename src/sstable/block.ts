import { getVarint32 } from '../codec.js';
import type { Comparator } from '../comparator.js';
import { Status } from '../status.js';

class BlockIterator {
  private pos = 0;
  private key_: Buffer = Buffer.alloc(0);
  private value_: Buffer = Buffer.alloc(0);
  private status_ = Status.ok();

  constructor(
    private data: Buffer,
    private restarts: number[],
    private numRestarts: number,
    private cmp: Comparator,
  ) {}

  valid(): boolean {
    return this.pos > 0; // pos > 0 means we've read an entry
  }

  key(): Buffer {
    return this.key_;
  }

  value(): Buffer {
    return this.value_;
  }

  status(): Status {
    return this.status_;
  }

  seekToFirst(): void {
    this.seekToRestart(0);
  }

  seek(target: Buffer): void {
    // Binary search over restart points
    let lo = 0;
    let hi = this.numRestarts - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      this.seekToRestart(mid);
      if (this.cmp.compare(this.key_, target) < 0) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    this.seekToRestart(lo);
    // Linear scan from restart point
    while (this.valid() && this.cmp.compare(this.key_, target) < 0) {
      this.next();
    }
  }

  next(): void {
    this.readEntry();
  }

  seekToLast(): void {
    if (this.numRestarts === 0) { this.pos = 0; return; }
    this.seekToRestart(this.numRestarts - 1);
    const dataEnd = this.data.length - 4 - this.numRestarts * 4;
    // Track the last valid entry as we scan forward from the last restart
    let lastKey = this.key_;
    let lastValue = this.value_;
    let lastPos = this.pos;
    while (true) {
      if (this.pos <= 0 || this.pos >= dataEnd) break;
      this.readEntry();
      if (!this.valid()) break;
      lastKey = this.key_;
      lastValue = this.value_;
      lastPos = this.pos;
    }
    this.key_ = lastKey;
    this.value_ = lastValue;
    this.pos = lastPos;
  }

  prev(): void {
    if (!this.valid()) return;
    const currentKey = this.key_;
    // Find which restart point would contain currentKey
    let bestRestart = 0;
    for (let i = 0; i < this.numRestarts; i++) {
      this.seekToRestart(i);
      if (!this.valid()) break;
      if (Buffer.compare(this.key_, currentKey) >= 0) break;
      bestRestart = i;
    }
    // Scan from that restart to find entry just before currentKey
    this.seekToRestart(bestRestart);
    let prevKey: Buffer | null = null;
    let prevValue: Buffer | null = null;
    let prevPos = 0;
    const dataEnd = this.data.length - 4 - this.numRestarts * 4;
    while (this.valid() && Buffer.compare(this.key_, currentKey) < 0) {
      prevKey = this.key_;
      prevValue = this.value_;
      prevPos = this.pos;
      this.readEntry();
      if (this.pos >= dataEnd || this.pos === 0) break;
    }
    if (prevKey && prevValue) {
      this.pos = prevPos;
      this.key_ = prevKey;
      this.value_ = prevValue;
    } else {
      this.pos = 0; // No previous entry
    }
  }

  seekToRestart(index: number): void {
    if (index < 0 || index >= this.numRestarts) {
      this.pos = 0;
      return;
    }
    this.key_ = Buffer.alloc(0); // reset key at restart point
    this.pos = this.restarts[index];
    this.readEntry();
  }

  private readEntry(): void {
    const dataEnd = this.data.length - 4 - this.numRestarts * 4;
    if (this.pos >= dataEnd) {
      this.pos = 0;
      return;
    }

    try {
      const [shared, sLen] = getVarint32(this.data, this.pos);
      this.pos += sLen;
      const [nonShared, nsLen] = getVarint32(this.data, this.pos);
      this.pos += nsLen;
      const [valueLen, vLen] = getVarint32(this.data, this.pos);
      this.pos += vLen;

      // Build key: shared prefix from last key + new bytes
      const prefix = this.key_.subarray(0, shared);
      const suffix = this.data.subarray(this.pos, this.pos + nonShared);
      this.key_ = Buffer.concat([prefix, suffix]);
      this.pos += nonShared;
      this.value_ = this.data.subarray(this.pos, this.pos + valueLen);
      this.pos += valueLen;
    } catch {
      this.status_ = Status.corruption('varint decode error in BlockIterator');
      this.pos = 0;
    }
  }
}

export class Block {
  private data: Buffer;
  private restartsOffset: number;
  private numRestarts: number;

  constructor(data: Buffer) {
    this.data = data;
    // Bounds-check: prevent corrupted data from causing negative offsets (fix: crash on corrupt SST)
    if (data.length < 4) {
      this.numRestarts = 0;
      this.restartsOffset = 0;
      return;
    }
    const nr = data.readUInt32LE(data.length - 4);
    const ro = data.length - 4 - nr * 4;
    if (nr < 0 || nr > 1000000 || ro < 0 || ro >= data.length) {
      // Corrupted restart count — clamp to safe values
      this.numRestarts = 0;
      this.restartsOffset = 0;
      return;
    }
    this.numRestarts = nr;
    this.restartsOffset = ro;
  }

  iterator(cmp: Comparator): BlockIterator {
    const restarts: number[] = [];
    for (let i = 0; i < this.numRestarts; i++) {
      const offset = this.restartsOffset + i * 4;
      if (offset >= 0 && offset + 4 <= this.data.length) {
        restarts.push(this.data.readUInt32LE(offset));
      }
    }
    return new BlockIterator(this.data, restarts, this.numRestarts, cmp);
  }

  size(): number {
    return this.data.length;
  }
}
