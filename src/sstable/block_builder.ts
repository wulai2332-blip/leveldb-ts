import { putVarint32 } from '../codec.js';

export class BlockBuilder {
  private buffer: Buffer[] = [];
  private restarts: number[] = [0];
  private counter = 0;
  private finished = false;
  private lastKey: Buffer = Buffer.alloc(0);

  constructor(private restartInterval: number) {}

  add(key: Buffer, value: Buffer): void {
    if (this.finished) throw new Error('BlockBuilder already finished');
    if (this.counter % this.restartInterval === 0) {
      this.restarts.push(this.byteLength());
      this.encodeEntry(0, key.length, value.length, key, value);
    } else {
      const shared = this.sharedPrefixLen(this.lastKey, key);
      this.encodeEntry(
        shared,
        key.length - shared,
        value.length,
        key.subarray(shared),
        value,
      );
    }
    this.lastKey = key;
    this.counter++;
  }

  finish(): Buffer {
    if (this.finished) throw new Error('BlockBuilder already finished');
    this.finished = true;
    for (const r of this.restarts) {
      const buf = Buffer.alloc(4);
      buf.writeUInt32LE(r, 0);
      this.buffer.push(buf);
    }
    const countBuf = Buffer.alloc(4);
    countBuf.writeUInt32LE(this.restarts.length, 0);
    this.buffer.push(countBuf);
    return Buffer.concat(this.buffer);
  }

  estimatedSize(): number {
    return this.byteLength();
  }

  private byteLength(): number {
    return this.buffer.reduce((sum, b) => sum + b.length, 0);
  }

  private encodeEntry(
    shared: number,
    nonShared: number,
    valueLen: number,
    nonSharedKey: Buffer,
    value: Buffer,
  ): void {
    this.buffer.push(putVarint32(shared));
    this.buffer.push(putVarint32(nonShared));
    this.buffer.push(putVarint32(valueLen));
    this.buffer.push(nonSharedKey);
    this.buffer.push(value);
  }

  private sharedPrefixLen(a: Buffer, b: Buffer): number {
    const limit = Math.min(a.length, b.length);
    let i = 0;
    while (i < limit && a[i] === b[i]) i++;
    return i;
  }
}
