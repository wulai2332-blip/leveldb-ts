import { openSync, writeSync, closeSync, fsyncSync } from 'node:fs';
import { crc32, crc32cMask } from '../codec.js';

const kBlockSize = 32768; // 32KB

enum RecordType {
  Full = 1,
  First = 2,
  Middle = 3,
  Last = 4,
}

export class LogWriter {
  private blockOffset = 0;
  private fd: number;

  constructor(private filename: string) {
    this.fd = openSync(filename, 'w');
  }

  addRecord(data: Buffer): void {
    let left = data.length;
    let begin = true;

    while (left > 0 || begin) {
      const leftover = kBlockSize - this.blockOffset;
      if (leftover < 7) {
        // can't fit header (7 bytes) -> pad block
        this.fillBlock();
        continue;
      }

      const avail = leftover - 7; // 7 bytes header: checksum(4) + length(2) + type(1)
      const fragmentLength = Math.min(left, avail);
      let type: RecordType;
      const end = data.length - left;
      if (begin && left === fragmentLength) {
        type = RecordType.Full;
      } else if (begin) {
        type = RecordType.First;
      } else if (left === fragmentLength) {
        type = RecordType.Last;
      } else {
        type = RecordType.Middle;
      }

      this.emitRecord(type, data.subarray(end, end + fragmentLength));
      left -= fragmentLength;
      begin = false;
    }
  }

  private emitRecord(type: RecordType, data: Buffer): void {
    const header = Buffer.alloc(7);
    const crc = crc32(Buffer.concat([Buffer.from([type]), data]));
    const masked = crc32cMask(crc);
    header.writeUInt32LE(masked, 0);
    header.writeUInt16LE(data.length, 4);
    header.writeUInt8(type, 6);

    writeSync(this.fd, header, 0, header.length);
    writeSync(this.fd, data, 0, data.length);
    this.blockOffset += header.length + data.length;
  }

  private fillBlock(): void {
    const padSize = kBlockSize - this.blockOffset;
    const pad = Buffer.alloc(padSize);
    pad.fill(0);
    writeSync(this.fd, pad);
    this.blockOffset = 0;
  }

  sync(): void {
    fsyncSync(this.fd);
  }

  async close(): Promise<void> {
    fsyncSync(this.fd);
    closeSync(this.fd);
  }
}
