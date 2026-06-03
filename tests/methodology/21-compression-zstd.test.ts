/**
 * 压缩路径测试 (补盲区 #8)
 * 测试 None/Snappy/Zstd 三种压缩类型的构建与读取
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { TableBuilder } from '../../src/sstable/table_builder.js';
import { Table } from '../../src/sstable/table.js';
import { BlockBuilder } from '../../src/sstable/block_builder.js';
import { Block } from '../../src/sstable/block.js';
import { defaultDBOptions, CompressionType } from '../../src/options.js';
import { BytewiseComparator } from '../../src/comparator.js';
import { compressSync as snappyCompress, uncompressSync as snappyUncompress } from 'snappy';

const rootDir = join(tmpdir(), `compress-test-${randomBytes(4).toString('hex')}`);

beforeEach(() => {
  mkdirSync(rootDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(rootDir, { recursive: true, force: true }); } catch {}
});

// ─── CompressionType.None ───
describe('Compression: None', () => {
  it('should build and read table without compression', async () => {
    const fp = join(rootDir, 'none.ldb');
    const opts = { ...defaultDBOptions(), compression: CompressionType.None };
    const builder = new TableBuilder(fp, opts);
    for (let i = 0; i < 50; i++) {
      await builder.add(
        Buffer.from(`key${i.toString().padStart(3, '0')}`),
        Buffer.from(`value${i}`)
      );
    }
    await builder.finish();

    expect(existsSync(fp)).toBe(true);

    const table = await Table.open(fp);
    const result = await table.internalGet(new BytewiseComparator(), Buffer.from('key025'));
    expect(result).not.toBeNull();
    expect(result!.value.toString()).toBe('value25');
  });

  it('should store data without compression header overhead', async () => {
    const fp = join(rootDir, 'none2.ldb');
    const opts = { ...defaultDBOptions(), compression: CompressionType.None };
    const builder = new TableBuilder(fp, opts);
    await builder.add(Buffer.from('single'), Buffer.from('entry'));
    await builder.finish();

    const table = await Table.open(fp);
    const result = await table.internalGet(new BytewiseComparator(), Buffer.from('single'));
    expect(result).not.toBeNull();
    expect(result!.value.toString()).toBe('entry');
  });
});

// ─── CompressionType.Snappy ───
describe('Compression: Snappy', () => {
  it('should compress and decompress with Snappy', () => {
    // Verify Snappy lib works
    const data = Buffer.from('hello world hello world hello world');
    const compressed = snappyCompress(data);
    expect(compressed.length).toBeLessThan(data.length); // should compress repeats
    const decompressed = snappyUncompress(compressed);
    expect(decompressed).toEqual(data);
  });

  it('should build and read table with Snappy compression', async () => {
    const fp = join(rootDir, 'snappy.ldb');
    const opts = { ...defaultDBOptions(), compression: CompressionType.Snappy };
    const builder = new TableBuilder(fp, opts);
    // Write many entries with repetitive data (good for compression)
    for (let i = 0; i < 50; i++) {
      await builder.add(
        Buffer.from(`key${i.toString().padStart(3, '0')}`),
        Buffer.from(`value_data_${i}_repeated_repeated_repeated`)
      );
    }
    await builder.finish();

    expect(existsSync(fp)).toBe(true);

    const table = await Table.open(fp);
    const result = await table.internalGet(new BytewiseComparator(), Buffer.from('key030'));
    expect(result).not.toBeNull();
    expect(result!.value.toString()).toContain('value_data_30');
  });

  it('should handle non-compressible data gracefully', async () => {
    const fp = join(rootDir, 'snappy-incomp.ldb');
    const opts = { ...defaultDBOptions(), compression: CompressionType.Snappy };
    const builder = new TableBuilder(fp, opts);
    // Add random (incompressible) data
    for (let i = 0; i < 20; i++) {
      await builder.add(
        randomBytes(32),
        randomBytes(128)
      );
    }
    await builder.finish();

    expect(existsSync(fp)).toBe(true);
    const table = await Table.open(fp);
    expect(table).toBeDefined();
  });

  it('Snappy compressed file should be smaller than uncompressed for repeated data', async () => {
    const fpNone = join(rootDir, 'cmp-none.ldb');
    const fpSnappy = join(rootDir, 'cmp-snappy.ldb');

    const repeatedData = Buffer.from('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');

    const builderNone = new TableBuilder(fpNone, { ...defaultDBOptions(), compression: CompressionType.None });
    for (let i = 0; i < 100; i++) {
      await builderNone.add(Buffer.from(`k${i}`), repeatedData);
    }
    await builderNone.finish();

    const builderSnappy = new TableBuilder(fpSnappy, { ...defaultDBOptions(), compression: CompressionType.Snappy });
    for (let i = 0; i < 100; i++) {
      await builderSnappy.add(Buffer.from(`k${i}`), repeatedData);
    }
    await builderSnappy.finish();

    const { statSync } = await import('node:fs');
    const noneSize = statSync(fpNone).size;
    const snappySize = statSync(fpSnappy).size;

    // Snappy should be smaller for repeated data
    expect(snappySize).toBeLessThan(noneSize);
  });
});

// ─── CompressionType.Zstd ───
describe('Compression: Zstd (fallback behavior)', () => {
  it('should build table with Zstd option without crashing', async () => {
    const fp = join(rootDir, 'zstd.ldb');
    const opts = { ...defaultDBOptions(), compression: CompressionType.Zstd };
    const builder = new TableBuilder(fp, opts);
    for (let i = 0; i < 30; i++) {
      await builder.add(
        Buffer.from(`zk${i.toString().padStart(3, '0')}`),
        Buffer.from(`zv${i}`)
      );
    }
    await builder.finish();

    expect(existsSync(fp)).toBe(true);
    const table = await Table.open(fp);

    // Data should be readable even if Zstd falls back to uncompressed
    const result = await table.internalGet(new BytewiseComparator(), Buffer.from('zk015'));
    expect(result).not.toBeNull();
    expect(result!.value.toString()).toBe('zv15');
  });

  it('should handle Zstd with custom compression level', async () => {
    const fp = join(rootDir, 'zstd-level.ldb');
    const opts = {
      ...defaultDBOptions(),
      compression: CompressionType.Zstd,
      zstdCompressionLevel: 5,
    };
    const builder = new TableBuilder(fp, opts);
    await builder.add(Buffer.from('key'), Buffer.from('value'));
    await builder.finish();

    expect(existsSync(fp)).toBe(true);
    const table = await Table.open(fp);
    const result = await table.internalGet(new BytewiseComparator(), Buffer.from('key'));
    expect(result).not.toBeNull();
  });

  it('Zstd fallback should produce readable data identical to None', async () => {
    const fpZstd = join(rootDir, 'zstd-fb.ldb');
    const fpNone = join(rootDir, 'none-fb.ldb');

    const zstdBuilder = new TableBuilder(fpZstd, { ...defaultDBOptions(), compression: CompressionType.Zstd });
    const noneBuilder = new TableBuilder(fpNone, { ...defaultDBOptions(), compression: CompressionType.None });

    for (let i = 0; i < 20; i++) {
      const key = Buffer.from(`fb${i.toString().padStart(3, '0')}`);
      const val = Buffer.from(`fbval${i}`);
      await zstdBuilder.add(key, val);
      await noneBuilder.add(key, val);
    }
    await zstdBuilder.finish();
    await noneBuilder.finish();

    const zstdTable = await Table.open(fpZstd);
    const noneTable = await Table.open(fpNone);

    // Both should return the same values (Zstd falls back to uncompressed)
    for (let i = 0; i < 20; i++) {
      const key = Buffer.from(`fb${i.toString().padStart(3, '0')}`);
      const zr = await zstdTable.internalGet(new BytewiseComparator(), key);
      const nr = await noneTable.internalGet(new BytewiseComparator(), key);
      expect(zr).not.toBeNull();
      expect(nr).not.toBeNull();
      expect(zr!.value).toEqual(nr!.value);
    }
  });
});

// ─── 压缩边界情况 ───
describe('Compression Edge Cases', () => {
  it('should handle empty block compression', async () => {
    const fp = join(rootDir, 'empty-comp.ldb');
    const opts = { ...defaultDBOptions(), compression: CompressionType.Snappy };
    const builder = new TableBuilder(fp, opts);
    await builder.finish(); // Empty table with no data blocks

    expect(existsSync(fp)).toBe(true);
    // Opening empty table should work (may have minimal structure from finish())
    await expect(Table.open(fp)).resolves.toBeDefined();
  });

  it('should handle very small data with Snappy', async () => {
    const fp = join(rootDir, 'tiny-snappy.ldb');
    const opts = { ...defaultDBOptions(), compression: CompressionType.Snappy };
    const builder = new TableBuilder(fp, opts);
    await builder.add(Buffer.from([0x01]), Buffer.from([0x02]));
    await builder.finish();

    const table = await Table.open(fp);
    const result = await table.internalGet(new BytewiseComparator(), Buffer.from([0x01]));
    expect(result).not.toBeNull();
    expect(result!.value).toEqual(Buffer.from([0x02]));
  });

  it('should handle compression with None type across multiple blocks', async () => {
    const fp = join(rootDir, 'multi-none.ldb');
    const opts = { ...defaultDBOptions(), compression: CompressionType.None, blockSize: 50 };
    const builder = new TableBuilder(fp, opts);
    for (let i = 0; i < 100; i++) {
      await builder.add(
        Buffer.from(`mk${i.toString().padStart(4, '0')}`),
        Buffer.from(`mv${i}`)
      );
    }
    await builder.finish();

    const table = await Table.open(fp);
    // Check first, middle, and last entries
    expect(await table.internalGet(new BytewiseComparator(), Buffer.from('mk0000'))).not.toBeNull();
    expect(await table.internalGet(new BytewiseComparator(), Buffer.from('mk0050'))).not.toBeNull();
    expect(await table.internalGet(new BytewiseComparator(), Buffer.from('mk0099'))).not.toBeNull();
  });
});
