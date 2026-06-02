import { readFileSync, open as fsOpen } from 'node:fs';
import type { Comparator } from '../comparator.js';
import { Block } from './block.js';
import { getVarint64 } from '../codec.js';
import { CompressionType } from '../options.js';
import { uncompressSync as snappyUncompress } from 'snappy';

function decompressBlock(raw: Buffer): Buffer {
  if (raw.length === 0) return raw;
  const compressionType = raw[0] as CompressionType;
  const data = raw.subarray(1);

  switch (compressionType) {
    case CompressionType.None:
      return data;
    case CompressionType.Snappy:
      return snappyUncompress(data) as Buffer;
    case CompressionType.Zstd: {
      // @mongodb-js/zstd only has an async API; falling back to uncompressed.
      // TODO: add zstd decompression when sync API is available
      return data;
    }
    default:
      return data;
  }
}

interface BlockHandle {
  offset: number;
  size: number;
}

export class Table {
  private indexBlock: Block;
  private fileData: Buffer;

  private constructor(
    fileData: Buffer,
    private metaIndexHandle: BlockHandle,
    private indexHandle: BlockHandle
  ) {
    this.fileData = fileData;
    this.indexBlock = new Block(this.readBlockData(indexHandle));
  }

  static async open(filename: string): Promise<Table> {
    const fileData = readFileSync(filename);
    if (fileData.length < 48) {
      throw new Error('File too small to be a valid SSTable');
    }

    const footer = fileData.subarray(fileData.length - 48);
    // Verify magic
    const magic = footer.subarray(40, 48);
    const expectedMagic = Buffer.from('\x57\xfb\x80\x8b\x24\x75\x47\xdb', 'binary');
    if (Buffer.compare(magic, expectedMagic) !== 0) {
      throw new Error('Invalid SSTable magic number');
    }

    const metaOffset = Number(footer.readBigUInt64LE(0));
    const metaSize = Number(footer.readBigUInt64LE(8));
    const indexOffset = Number(footer.readBigUInt64LE(16));
    const indexSize = Number(footer.readBigUInt64LE(24));

    return new Table(
      fileData,
      { offset: metaOffset, size: metaSize },
      { offset: indexOffset, size: indexSize }
    );
  }

  internalGet(cmp: Comparator, key: Buffer): { value: Buffer } | null {
    const idxIter = this.indexBlock.iterator(cmp);
    idxIter.seek(key);
    if (!idxIter.valid()) return null;

    const handle = this.decodeHandle(idxIter.value());
    const dataBlock = new Block(this.readBlockData(handle));
    const dataIter = dataBlock.iterator(cmp);
    dataIter.seek(key);
    if (!dataIter.valid() || cmp.compare(dataIter.key(), key) !== 0) {
      return null;
    }
    return { value: dataIter.value() };
  }

  iterator(cmp: Comparator) {
    // TwoLevelIterator: iterate through index blocks → data blocks
    return new TwoLevelIterator(this.fileData, this.indexBlock, this.indexHandle, cmp);
  }

  private readBlockData(handle: BlockHandle): Buffer {
    const raw = this.fileData.subarray(handle.offset, handle.offset + handle.size);
    return decompressBlock(raw);
  }

  private decodeHandle(data: Buffer): BlockHandle {
    const [offset, offsetLen] = getVarint64(data, 0);
    const [size] = getVarint64(data, offsetLen);
    return { offset: Number(offset), size: Number(size) };
  }
}

class TwoLevelIterator {
  private idxIter: ReturnType<Block['iterator']>;
  private dataIter: ReturnType<Block['iterator']> | null = null;

  constructor(
    private fileData: Buffer,
    indexBlock: Block,
    indexHandle: BlockHandle,
    private cmp: Comparator
  ) {
    this.idxIter = indexBlock.iterator(cmp);
  }

  valid(): boolean {
    return this.dataIter !== null && this.dataIter.valid();
  }

  key(): Buffer {
    return this.dataIter!.key();
  }

  value(): Buffer {
    return this.dataIter!.value();
  }

  seekToFirst(): void {
    this.idxIter.seekToFirst();
    if (this.idxIter.valid()) {
      this.openDataBlock();
      this.dataIter?.seekToFirst();
    }
  }

  seek(target: Buffer): void {
    this.idxIter.seek(target);
    if (this.idxIter.valid()) {
      this.openDataBlock();
      this.dataIter?.seek(target);
    }
  }

  next(): void {
    if (!this.dataIter) return;
    this.dataIter.next();
    if (!this.dataIter.valid()) {
      // Move to next data block
      this.idxIter.next();
      if (this.idxIter.valid()) {
        this.openDataBlock();
        this.dataIter?.seekToFirst();
      } else {
        this.dataIter = null;
      }
    }
  }

  private openDataBlock(): void {
    const handleValue = this.idxIter.value();
    const handle = this.decodeHandle(handleValue);
    const raw = this.fileData.subarray(handle.offset, handle.offset + handle.size);
    const data = decompressBlock(raw);
    const dataBlock = new Block(data);
    this.dataIter = dataBlock.iterator(this.cmp);
  }

  private decodeHandle(data: Buffer): BlockHandle {
    const [offset, offsetLen] = getVarint64(data, 0);
    const [size] = getVarint64(data, offsetLen);
    return { offset: Number(offset), size: Number(size) };
  }
}

// Convenience export
export const openTable = Table.open;
