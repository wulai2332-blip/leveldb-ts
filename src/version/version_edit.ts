import { putVarint32, getVarint32, putVarint64, getVarint64 } from '../codec.js';
import { VersionEditTag } from './version_edit_tag.js';
import type { FileMetaData } from '../types.js';

interface AddedFile {
  level: number;
  meta: FileMetaData;
}

export class VersionEdit {
  comparatorName: string | null = null;
  logNumber: number | null = null;
  prevLogNumber: number | null = null;
  nextFileNumber: number | null = null;
  lastSequence: bigint | null = null;
  compactPointers: Map<number, Buffer> = new Map();
  deletedFiles: Map<number, Set<number>> = new Map(); // level → fileNumbers
  addedFiles: AddedFile[] = [];

  setComparatorName(name: string): void { this.comparatorName = name; }
  setLogNumber(num: number): void { this.logNumber = num; }
  setPrevLogNumber(num: number): void { this.prevLogNumber = num; }
  setNextFile(num: number): void { this.nextFileNumber = num; }
  setLastSequence(seq: bigint): void { this.lastSequence = seq; }
  setCompactPointer(level: number, key: Buffer): void { this.compactPointers.set(level, key); }

  deleteFile(level: number, fileNumber: number): void {
    let set = this.deletedFiles.get(level);
    if (!set) {
      set = new Set();
      this.deletedFiles.set(level, set);
    }
    set.add(fileNumber);
  }

  addFile(level: number, meta: FileMetaData): void {
    this.addedFiles.push({ level, meta });
  }

  encode(): Buffer {
    const parts: Buffer[] = [];
    if (this.comparatorName !== null) {
      parts.push(this.encodeTag(VersionEditTag.Comparator, Buffer.from(this.comparatorName)));
    }
    if (this.logNumber !== null) {
      parts.push(this.encodeTag(VersionEditTag.LogNumber, putVarint64(BigInt(this.logNumber))));
    }
    if (this.prevLogNumber !== null) {
      parts.push(this.encodeTag(VersionEditTag.PrevLogNumber, putVarint64(BigInt(this.prevLogNumber))));
    }
    if (this.nextFileNumber !== null) {
      parts.push(this.encodeTag(VersionEditTag.NextFileNumber, putVarint64(BigInt(this.nextFileNumber))));
    }
    if (this.lastSequence !== null) {
      parts.push(this.encodeTag(VersionEditTag.LastSequence, putVarint64(this.lastSequence)));
    }
    for (const [level, key] of this.compactPointers) {
      parts.push(this.encodeTag(VersionEditTag.CompactPointer,
        Buffer.concat([putVarint32(level), this.encodeLenPrefixed(key)])));
    }
    for (const [level, files] of this.deletedFiles) {
      for (const fn of files) {
        parts.push(this.encodeTag(VersionEditTag.DeletedFile,
          Buffer.concat([putVarint32(level), putVarint64(BigInt(fn))])));
      }
    }
    for (const { level, meta } of this.addedFiles) {
      const data = Buffer.concat([
        putVarint32(level),
        putVarint64(BigInt(meta.fileNumber)),
        putVarint64(BigInt(meta.fileSize)),
        this.encodeLenPrefixed(meta.smallest),
        this.encodeLenPrefixed(meta.largest),
      ]);
      parts.push(this.encodeTag(VersionEditTag.NewFile, data));
    }
    return Buffer.concat(parts);
  }

  static decode(buf: Buffer): VersionEdit {
    const edit = new VersionEdit();
    let pos = 0;
    while (pos < buf.length) {
      const [tag, tLen] = getVarint32(buf, pos);
      pos += tLen;
      const [len, lLen] = getVarint32(buf, pos);
      pos += lLen;
      const data = buf.subarray(pos, pos + len);
      pos += len;

      switch (tag) {
        case VersionEditTag.Comparator:
          edit.comparatorName = data.toString();
          break;
        case VersionEditTag.LogNumber:
          edit.logNumber = Number(getVarint64(data)[0]);
          break;
        case VersionEditTag.PrevLogNumber:
          edit.prevLogNumber = Number(getVarint64(data)[0]);
          break;
        case VersionEditTag.NextFileNumber:
          edit.nextFileNumber = Number(getVarint64(data)[0]);
          break;
        case VersionEditTag.LastSequence:
          edit.lastSequence = getVarint64(data)[0];
          break;
        case VersionEditTag.CompactPointer: {
          let cp = 0;
          const [level, lLen] = getVarint32(data, cp); cp += lLen;
          const [keyLen, klLen] = getVarint32(data, cp); cp += klLen;
          edit.compactPointers.set(level, data.subarray(cp, cp + keyLen));
          break;
        }
        case VersionEditTag.DeletedFile: {
          let dp = 0;
          const [level, lLen] = getVarint32(data, dp); dp += lLen;
          const [fn] = getVarint64(data, dp);
          edit.deleteFile(level, Number(fn));
          break;
        }
        case VersionEditTag.NewFile: {
          let np = 0;
          const [level, lLen] = getVarint32(data, np); np += lLen;
          const [fn, fnLen] = getVarint64(data, np); np += fnLen;
          const [fs, fsLen] = getVarint64(data, np); np += fsLen;
          const [smallestLen, slLen] = getVarint32(data, np); np += slLen;
          const smallest = data.subarray(np, np + smallestLen); np += smallestLen;
          const [largestLen, llLen] = getVarint32(data, np); np += llLen;
          const largest = data.subarray(np, np + largestLen);
          edit.addFile(level, {
            fileNumber: Number(fn),
            fileSize: Number(fs),
            smallest,
            largest,
          });
          break;
        }
      }
    }
    return edit;
  }

  private encodeTag(tag: VersionEditTag, data: Buffer): Buffer {
    return Buffer.concat([putVarint32(tag), putVarint32(data.length), data]);
  }

  private encodeLenPrefixed(data: Buffer): Buffer {
    return Buffer.concat([putVarint32(data.length), data]);
  }
}
