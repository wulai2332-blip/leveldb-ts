import { appendFileSync } from 'node:fs';
import { BlockBuilder } from './block_builder.js';
import { putVarint64 } from '../codec.js';
import { CompressionType } from '../options.js';
import type { DBOptions } from '../options.js';
import { compressSync as snappyCompress } from 'snappy';
import { compress as zstdCompress } from '@mongodb-js/zstd';

interface BlockHandle {
  offset: number;
  size: number;
}

export class TableBuilder {
  private indexBuilder: BlockBuilder;
  private dataBuilder: BlockBuilder;
  private fileOffset = 0;
  private lastKey: Buffer = Buffer.alloc(0);
  private numEntries = 0;
  private pendingIndexEntry = false;
  private finished = false;
  private keys: Buffer[] = [];

  constructor(
    private filename: string,
    private options: Required<DBOptions>
  ) {
    this.indexBuilder = new BlockBuilder(options.blockRestartInterval);
    this.dataBuilder = new BlockBuilder(options.blockRestartInterval);
  }

  async add(key: Buffer, value: Buffer): Promise<void> {
    if (this.finished) throw new Error('TableBuilder already finished');

    this.lastKey = key;
    this.numEntries++;
    this.pendingIndexEntry = true;
    this.dataBuilder.add(key, value);
    this.keys.push(key);

    if (this.dataBuilder.estimatedSize() >= this.options.blockSize) {
      await this.flushDataBlock();
    }
  }

  async finish(): Promise<void> {
    if (this.finished) throw new Error('TableBuilder already finished');
    this.finished = true;

    if (this.pendingIndexEntry) {
      await this.flushDataBlock();
    }

    // Write filter block
    let filterBlockHandle: BlockHandle;
    if (this.options.filterPolicy && this.keys.length > 0) {
      const filter = this.options.filterPolicy.createFilter(this.keys);
      filterBlockHandle = await this.writeRawBlock(filter);
    } else {
      filterBlockHandle = await this.writeRawBlock(Buffer.alloc(0));
    }

    // Write meta index block (filter entry)
    const metaIndexBuilder = new BlockBuilder(this.options.blockRestartInterval);
    if (filterBlockHandle.size > 0) {
      const key = Buffer.from('filter.leveldb.BuiltinBloomFilter2');
      const value = this.encodeHandle(filterBlockHandle);
      metaIndexBuilder.add(key, value);
    }
    const metaIndexHandle = await this.writeBlock(metaIndexBuilder);

    // Write index block
    const indexHandle = await this.writeBlock(this.indexBuilder);

    // Write footer
    this.writeFooter(metaIndexHandle, indexHandle);
  }

  private async flushDataBlock(): Promise<void> {
    this.pendingIndexEntry = false;
    const handle = await this.writeBlock(this.dataBuilder);
    this.indexBuilder.add(this.lastKey, this.encodeHandle(handle));
    this.dataBuilder = new BlockBuilder(this.options.blockRestartInterval);
  }

  private async writeBlock(builder: BlockBuilder): Promise<BlockHandle> {
    const data = builder.finish();
    return this.writeRawBlock(data);
  }

  private async writeRawBlock(data: Buffer): Promise<BlockHandle> {
    const blockData = await this.compressBlock(data);
    const handle: BlockHandle = { offset: this.fileOffset, size: blockData.length };
    appendFileSync(this.filename, blockData);
    this.fileOffset += blockData.length;
    return handle;
  }

  private async compressBlock(data: Buffer): Promise<Buffer> {
    const compType = this.options.compression;

    if (compType === CompressionType.Snappy) {
      try {
        const compressed = snappyCompress(data);
        if (compressed.length < data.length) {
          return Buffer.concat([Buffer.from([CompressionType.Snappy]), compressed]);
        }
      } catch {
        // compression failed, fall through
      }
    } else if (compType === CompressionType.Zstd) {
      try {
        const compressed = Buffer.from(await zstdCompress(data, this.options.zstdCompressionLevel));
        if (compressed.length < data.length) {
          return Buffer.concat([Buffer.from([CompressionType.Zstd]), compressed]);
        }
      } catch {
        // compression failed, fall through
      }
    }

    // Store uncompressed
    return Buffer.concat([Buffer.from([CompressionType.None]), data]);
  }

  private encodeHandle(handle: BlockHandle): Buffer {
    return Buffer.concat([
      putVarint64(BigInt(handle.offset)),
      putVarint64(BigInt(handle.size)),
    ]);
  }

  private writeFooter(metaIndex: BlockHandle, index: BlockHandle): void {
    const buf = Buffer.alloc(48);
    buf.writeBigUInt64LE(BigInt(metaIndex.offset), 0);
    buf.writeBigUInt64LE(BigInt(metaIndex.size), 8);
    buf.writeBigUInt64LE(BigInt(index.offset), 16);
    buf.writeBigUInt64LE(BigInt(index.size), 24);
    // LevelDB magic number
    buf.write('\x57\xfb\x80\x8b\x24\x75\x47\xdb', 40, 'binary');
    appendFileSync(this.filename, buf);
    this.fileOffset += 48;
  }
}
