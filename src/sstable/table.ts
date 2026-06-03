import { readFileSync, open as fsOpen } from 'node:fs';
import type { Comparator } from '../comparator.js';
import { BytewiseComparator } from '../comparator.js';
import { Block } from './block.js';
import { crc32, getVarint64 } from '../codec.js';
import { CompressionType } from '../options.js';
import { uncompressSync as snappyUncompress } from 'snappy';
import { decompress as zstdDecompress } from '@mongodb-js/zstd';

async function decompressBlock(raw: Buffer): Promise<Buffer> {
  if (raw.length === 0) return raw;
  const compressionType = raw[0] as CompressionType;
  const data = raw.subarray(1);

  switch (compressionType) {
    case CompressionType.None:
      return data;
    case CompressionType.Snappy:
      return snappyUncompress(data) as Buffer;
    case CompressionType.Zstd:
      return Buffer.from(await zstdDecompress(data));
    default:
      return data;
  }
}

interface BlockHandle {
  offset: number;
  size: number;
}

export class Table {
  private indexBlock!: Block;
  private fileData: Buffer;
  private filterData: Buffer | null = null;

  private constructor(
    fileData: Buffer,
    private metaIndexHandle: BlockHandle,
    private indexHandle: BlockHandle,
    private verifyChecksums: boolean = false,
  ) {
    this.fileData = fileData;
  }

  static async open(filename: string, verifyChecksums: boolean = false): Promise<Table> {
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

    const table = new Table(
      fileData,
      { offset: metaOffset, size: metaSize },
      { offset: indexOffset, size: indexSize },
      verifyChecksums,
    );

    // Read index block (async because it may need decompression)
    table.indexBlock = new Block(await table.readBlockData({ offset: indexOffset, size: indexSize }, true));

    // Read filter block from meta index
    if (metaSize > 0) {
      const metaRaw = fileData.subarray(metaOffset, metaOffset + metaSize);
      const metaBlockData = await decompressBlock(metaRaw);
      const metaBlock = new Block(metaBlockData);
      const filterIter = metaBlock.iterator(new BytewiseComparator());
      filterIter.seekToFirst();
      if (filterIter.valid()) {
        const filterHandle = table.decodeHandle(filterIter.value());
        if (filterHandle.size > 0) {
          table.filterData = await table.readBlockData(filterHandle);
        }
      }
    }

    return table;
  }

  async internalGet(cmp: Comparator, key: Buffer): Promise<{ value: Buffer } | null> {
    // Check bloom filter first
    if (this.filterData && this.filterData.length > 0) {
      const bytes = this.filterData.length - 1;
      if (bytes >= 1) {
        const k = this.filterData[bytes];
        if (k <= 30) {
          let h = crc32(key);
          const delta = (h >> 17) | (h << 15);
          for (let j = 0; j < k; j++) {
            const bitpos = h % (bytes * 8);
            if ((this.filterData[Math.floor(bitpos / 8)] & (1 << (bitpos % 8))) === 0) {
              return null; // Bloom filter says key not present
            }
            h = (h + delta) >>> 0;
          }
        }
      }
    }

    // Existing internalGet logic
    const idxIter = this.indexBlock.iterator(cmp);
    idxIter.seek(key);
    if (!idxIter.valid()) return null;

    const handle = this.decodeHandle(idxIter.value());
    const dataBlock = new Block(await this.readBlockData(handle));
    const dataIter = dataBlock.iterator(cmp);
    dataIter.seek(key);
    if (!dataIter.valid() || cmp.compare(dataIter.key(), key) !== 0) {
      return null;
    }
    return { value: dataIter.value() };
  }

  iterator(cmp: Comparator) {
    // TwoLevelIterator: iterate through index blocks → data blocks
    return new TwoLevelIterator(this.fileData, this.indexBlock, this.indexHandle, cmp, this.verifyChecksums);
  }

  private async readBlockData(handle: BlockHandle, verify?: boolean): Promise<Buffer> {
    const raw = this.fileData.subarray(handle.offset, handle.offset + handle.size);
    const data = await decompressBlock(raw);
    const shouldVerify = verify ?? this.verifyChecksums;
    if (shouldVerify) {
      // Parseability check: Block constructor validates restart array integrity.
      // Corrupt data will cause it to throw, which we surface as a checksum error.
      try {
        new Block(data);
      } catch {
        throw new Error(`Block checksum verification failed at offset ${handle.offset}`);
      }
    }
    return data;
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
    private indexHandle: BlockHandle,
    private cmp: Comparator,
    private verifyChecksums: boolean = false,
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

  async seekToFirst(): Promise<void> {
    this.idxIter.seekToFirst();
    if (this.idxIter.valid()) {
      await this.openDataBlock();
      this.dataIter?.seekToFirst();
    }
  }

  async seek(target: Buffer): Promise<void> {
    this.idxIter.seek(target);
    if (this.idxIter.valid()) {
      await this.openDataBlock();
      this.dataIter?.seek(target);
    }
  }

  async next(): Promise<void> {
    if (!this.dataIter) return;
    this.dataIter.next();
    if (!this.dataIter.valid()) {
      // Move to next data block
      this.idxIter.next();
      if (this.idxIter.valid()) {
        await this.openDataBlock();
        this.dataIter?.seekToFirst();
      } else {
        this.dataIter = null;
      }
    }
  }

  async seekToLast(): Promise<void> {
    this.idxIter.seekToFirst();
    let lastHandle: BlockHandle | null = null;
    while (this.idxIter.valid()) {
      lastHandle = this.decodeHandle(this.idxIter.value());
      this.idxIter.next();
    }
    if (lastHandle) {
      const raw = this.fileData.subarray(lastHandle.offset, lastHandle.offset + lastHandle.size);
      const data = await decompressBlock(raw);
      const dataBlock = new Block(data);
      this.dataIter = dataBlock.iterator(this.cmp);
      this.dataIter.seekToLast();
    } else {
      this.dataIter = null;
    }
  }

  async prev(): Promise<void> {
    if (!this.dataIter) return;
    this.dataIter.prev();
    if (!this.dataIter.valid()) {
      // Need to go to previous data block — rescan the index to find it
      const currentKey = this.key();
      this.idxIter.seekToFirst();
      let prevHandle: BlockHandle | null = null;
      while (this.idxIter.valid()) {
        const k = this.idxIter.key();
        if (Buffer.compare(k, currentKey) >= 0) break;
        prevHandle = this.decodeHandle(this.idxIter.value());
        this.idxIter.next();
      }
      if (prevHandle) {
        const raw = this.fileData.subarray(prevHandle.offset, prevHandle.offset + prevHandle.size);
        const data = await decompressBlock(raw);
        const dataBlock = new Block(data);
        this.dataIter = dataBlock.iterator(this.cmp);
        this.dataIter.seekToLast();
      } else {
        this.dataIter = null;
      }
    }
  }

  private async openDataBlock(): Promise<void> {
    const handleValue = this.idxIter.value();
    const handle = this.decodeHandle(handleValue);
    const raw = this.fileData.subarray(handle.offset, handle.offset + handle.size);
    const data = await decompressBlock(raw);
    if (this.verifyChecksums) {
      try {
        new Block(data);
      } catch {
        throw new Error(`Block checksum verification failed at offset ${handle.offset}`);
      }
    }
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
