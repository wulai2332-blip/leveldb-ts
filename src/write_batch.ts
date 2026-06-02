import { ValueType } from './types.js';
import { putVarint32, getVarint32 } from './codec.js';

interface WriteBatchEntry {
  type: ValueType;
  key: Buffer;
  value: Buffer;
}

export class WriteBatch {
  private entries: WriteBatchEntry[] = [];
  private sizeBytes = 0;

  put(key: Buffer, value: Buffer): void {
    this.entries.push({ type: ValueType.Value, key, value });
    this.sizeBytes += key.length + value.length + 1;
  }

  delete(key: Buffer): void {
    this.entries.push({ type: ValueType.Deletion, key, value: Buffer.alloc(0) });
    this.sizeBytes += key.length + 1;
  }

  clear(): void {
    this.entries.length = 0;
    this.sizeBytes = 0;
  }

  approxSize(): number {
    return this.sizeBytes;
  }

  iterate(fn: (key: Buffer, value: Buffer, type: ValueType) => void): void {
    for (const entry of this.entries) {
      fn(entry.key, entry.value, entry.type);
    }
  }

  append(other: WriteBatch): void {
    for (const entry of other.entries) {
      this.entries.push({ ...entry, key: Buffer.from(entry.key), value: Buffer.from(entry.value) });
    }
    this.sizeBytes += other.sizeBytes;
  }

  encode(): Buffer {
    const parts: Buffer[] = [];
    // 8 bytes sequence (0 for now, filled by DB)
    parts.push(Buffer.alloc(8));
    // 4 bytes count
    const countBuf = Buffer.alloc(4);
    countBuf.writeUInt32LE(this.entries.length, 0);
    parts.push(countBuf);
    for (const entry of this.entries) {
      parts.push(Buffer.from([entry.type]));
      parts.push(putVarint32(entry.key.length));
      parts.push(entry.key);
      parts.push(putVarint32(entry.value.length));
      parts.push(entry.value);
    }
    return Buffer.concat(parts);
  }

  static decode(data: Buffer): WriteBatch {
    const batch = new WriteBatch();
    let pos = 12; // skip 8 bytes sequence + 4 bytes count
    const count = data.readUInt32LE(8);
    for (let i = 0; i < count; i++) {
      const type = data[pos++] as ValueType;
      const [keyLen, klLen] = getVarint32(data, pos);
      pos += klLen;
      const key = data.subarray(pos, pos + keyLen);
      pos += keyLen;
      const [valLen, vlLen] = getVarint32(data, pos);
      pos += vlLen;
      const value = data.subarray(pos, pos + valLen);
      pos += valLen;
      if (type === ValueType.Value) {
        batch.put(key, value);
      } else {
        batch.delete(key);
      }
    }
    return batch;
  }
}
