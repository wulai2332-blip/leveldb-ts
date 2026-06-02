import { readFileSync } from 'node:fs';
import { crc32, crc32cUnmask } from '../codec.js';

const kBlockSize = 32768;

enum RecordType {
  Full = 1,
  First = 2,
  Middle = 3,
  Last = 4,
}

export class LogReader {
  private data: Buffer;
  private offset = 0;
  private eof = false;

  constructor(filename: string) {
    this.data = readFileSync(filename);
  }

  readNext(): Buffer | null {
    if (this.eof) return null;

    let inFragment = false;
    const fragments: Buffer[] = [];

    while (true) {
      if (this.offset + 7 > this.data.length) {
        this.eof = true;
        return fragments.length > 0 ? Buffer.concat(fragments) : null;
      }

      const blockRemaining = kBlockSize - (this.offset % kBlockSize);
      if (blockRemaining < 7) {
        this.offset += blockRemaining;
        continue;
      }

      const header = this.data.subarray(this.offset, this.offset + 7);
      const checksum = header.readUInt32LE(0);
      const length = header.readUInt16LE(4);
      const type = header.readUInt8(6) as RecordType;

      if (length > blockRemaining - 7) {
        this.offset = Math.ceil((this.offset + 1) / kBlockSize) * kBlockSize;
        if (inFragment) return null; // corrupt fragment
        continue;
      }

      const payload = this.data.subarray(this.offset + 7, this.offset + 7 + length);

      // Verify checksum
      const actual = crc32(Buffer.concat([Buffer.from([type]), payload]));
      const expected = crc32cUnmask(checksum);
      if (actual !== expected) {
        if (inFragment) return null; // corrupt fragment
        this.offset += 7 + length;
        continue;
      }

      this.offset += 7 + length;

      switch (type) {
        case RecordType.Full:
          if (inFragment) return null;
          return payload;

        case RecordType.First:
          if (inFragment) return null;
          inFragment = true;
          fragments.push(payload);
          break;

        case RecordType.Middle:
          if (!inFragment) return null;
          fragments.push(payload);
          break;

        case RecordType.Last:
          if (!inFragment) return null;
          fragments.push(payload);
          return Buffer.concat(fragments);

        default:
          if (inFragment) return null;
          return null;
      }
    }
  }
}
