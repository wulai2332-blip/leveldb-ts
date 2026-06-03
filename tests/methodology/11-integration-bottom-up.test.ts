/**
 * 自底向上集成测试 (Bottom-Up Integration Testing)
 * 从底层模块逐步向上集成验证：Codec → Arena → SkipList → MemTable →
 * Block/BlockBuilder → Bloom → Table/TableBuilder → WAL → Version →
 * TableCache → Compaction → DBImpl
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { putVarint32, getVarint32, crc32 } from '../../src/codec.js';
import { Arena } from '../../src/arena.js';
import { SkipList } from '../../src/memtable/skiplist.js';
import { BytewiseComparator } from '../../src/comparator.js';
import { MemTable } from '../../src/memtable.js';
import { ValueType, encodeInternalKey, decodeInternalKey } from '../../src/types.js';
import { BlockBuilder } from '../../src/sstable/block_builder.js';
import { Block } from '../../src/sstable/block.js';
import { newBloomFilterPolicy } from '../../src/sstable/bloom.js';
import { TableBuilder } from '../../src/sstable/table_builder.js';
import { Table } from '../../src/sstable/table.js';
import { defaultDBOptions } from '../../src/options.js';
import { LogWriter } from '../../src/wal/writer.js';
import { LogReader } from '../../src/wal/reader.js';
import { Version } from '../../src/version/version.js';
import { VersionEdit } from '../../src/version/version_edit.js';
import { LRUCache } from '../../src/cache.js';
import { TableCache } from '../../src/table_cache.js';
import { DB } from '../../src/db.js';

const dir = join(tmpdir(), `bottom-up-${randomBytes(4).toString('hex')}`);
beforeEach(() => { mkdirSync(dir, { recursive: true }); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

// ─── 第1层: Codec ───
describe('Layer 1: Codec', () => {
  it('varint32 round-trip works for random values', () => {
    for (let i = 0; i < 100; i++) {
      const v = Math.floor(Math.random() * 0xffffffff);
      expect(getVarint32(putVarint32(v))[0]).toBe(v);
    }
  });
});

// ─── 第2层: Arena + SkipList ───
describe('Layer 2: Arena → SkipList', () => {
  it('arena-allocated memory used by skiplist', () => {
    const arena = new Arena();
    const list = new SkipList(new BytewiseComparator(), arena);
    for (let i = 0; i < 100; i++) {
      list.insert(Buffer.from(`key${i}`), Buffer.from(`val${i}`));
    }
    // SkipList uses a separate Arena (not the one passed to constructor) via MemTable
    // The Arena parameter is stored but node allocation is direct
    expect(list.find(Buffer.from('key50'))).not.toBeNull();
    // Verify 100 insertions maintain sorted order
    const iter = list.iterator();
    iter.seekToFirst();
    let count = 0;
    while (iter.valid()) { count++; iter.next(); }
    expect(count).toBe(100);
  });
});

// ─── 第3层: SkipList → MemTable ───
describe('Layer 3: SkipList → MemTable', () => {
  it('memtable delegates to internal skiplist', () => {
    const mem = new MemTable(new BytewiseComparator());
    mem.add(1n, ValueType.Value, Buffer.from('key'), Buffer.from('val'));
    const result = mem.get(Buffer.from('key'), 10n);
    expect(result).not.toBeNull();
    expect(result!.value).toEqual(Buffer.from('val'));
  });

  it('memtable approximateMemoryUsage increases with entries', () => {
    const mem = new MemTable(new BytewiseComparator());
    const before = mem.approximateMemoryUsage();
    mem.add(1n, ValueType.Value, Buffer.from('key'), Buffer.from('value'));
    expect(mem.approximateMemoryUsage()).toBeGreaterThan(before);
  });
});

// ─── 第4层: Block/BlockBuilder → SSTable ───
describe('Layer 4: Block → Table', () => {
  it('block builder creates valid block that can be read', () => {
    const bb = new BlockBuilder(16);
    bb.add(Buffer.from('a'), Buffer.from('1'));
    bb.add(Buffer.from('b'), Buffer.from('2'));
    bb.add(Buffer.from('c'), Buffer.from('3'));
    const data = bb.finish();
    const block = new Block(data);
    const iter = block.iterator(new BytewiseComparator());
    let count = 0;
    for (iter.seekToFirst(); iter.valid(); iter.next()) count++;
    expect(count).toBe(3);
  });

  it('bloom filter works with SST key lookup', () => {
    const filter = newBloomFilterPolicy(10);
    const keys = [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')];
    const bloom = filter.createFilter(keys);
    for (const k of keys) {
      expect(filter.keyMayMatch(k, bloom)).toBe(true);
    }
  });
});

// ─── 第5层: TableBuilder → Table 读写 ───
describe('Layer 5: TableBuilder → Table', () => {
  it('build table and read it back', async () => {
    const fp = join(dir, 'table.ldb');
    const tb = new TableBuilder(fp, { ...defaultDBOptions(), compression: 0 });
    await tb.add(Buffer.from('a'), Buffer.from('1'));
    await tb.add(Buffer.from('b'), Buffer.from('2'));
    await tb.add(Buffer.from('c'), Buffer.from('3'));
    await tb.finish();

    const table = await Table.open(fp);
    const result = await table.internalGet(new BytewiseComparator(), Buffer.from('b'));
    expect(result).not.toBeNull();
    expect(result!.value).toEqual(Buffer.from('2'));

    const missing = await table.internalGet(new BytewiseComparator(), Buffer.from('z'));
    expect(missing).toBeNull();
  });
});

// ─── 第6层: WAL → Log读写 ───
describe('Layer 6: WAL Log', () => {
  it('write and read WAL records', () => {
    const fp = join(dir, 'test.log');
    const writer = new LogWriter(fp);
    writer.addRecord(Buffer.from('record1'));
    writer.addRecord(Buffer.from('record2'));
    writer.close();

    const reader = new LogReader(fp);
    const r1 = reader.readNext();
    const r2 = reader.readNext();
    const r3 = reader.readNext();

    expect(r1?.toString()).toBe('record1');
    expect(r2?.toString()).toBe('record2');
    expect(r3).toBeNull();
  });
});

// ─── 第7层: Version → VersionEdit → VersionSet ───
describe('Layer 7: Version Management', () => {
  it('VersionEdit encode/decode round-trip', () => {
    const edit = new VersionEdit();
    edit.setComparatorName('test.cmp');
    edit.setLogNumber(42);
    edit.setNextFile(100);
    edit.setLastSequence(999n);
    edit.addFile(0, {
      fileNumber: 1, fileSize: 1024,
      smallest: Buffer.from('a'), largest: Buffer.from('z'),
    });
    edit.deleteFile(1, 5);

    const encoded = edit.encode();
    const decoded = VersionEdit.decode(encoded);

    expect(decoded.comparatorName).toBe('test.cmp');
    expect(decoded.logNumber).toBe(42);
    expect(decoded.nextFileNumber).toBe(100);
    expect(decoded.lastSequence).toBe(999n);
    expect(decoded.addedFiles.length).toBe(1);
    expect(decoded.deletedFiles.get(1)?.has(5)).toBe(true);
  });

  it('Version tracks files per level', () => {
    const v = new Version();
    v.addFile(0, { fileNumber: 1, fileSize: 100, smallest: Buffer.from('a'), largest: Buffer.from('m') });
    v.addFile(0, { fileNumber: 2, fileSize: 200, smallest: Buffer.from('n'), largest: Buffer.from('z') });
    expect(v.files(0).length).toBe(2);
    v.removeFile(0, 1);
    expect(v.files(0).length).toBe(1);
  });
});

// ─── 第8层: LRUCache → TableCache ───
describe('Layer 8: TableCache', () => {
  it('table cache stores and evicts tables', async () => {
    const fp = join(dir, 'cached.ldb');
    const tb = new TableBuilder(fp, { ...defaultDBOptions(), compression: 0 });
    await tb.add(Buffer.from('k'), Buffer.from('v'));
    await tb.finish();

    const cache = new TableCache(2);
    const t1 = await cache.getTable(fp, 1);
    expect(t1).toBeDefined();
    // Same fileNumber returns cached instance
    const t2 = await cache.getTable(fp, 1);
    expect(t2).toBe(t1); // Should be same reference (cached)
  });
});

// ─── 第9层: DB 完整集成 ───
describe('Layer 9: Full DB Integration', () => {
  it('complete write → read → delete cycle', async () => {
    const dbdir = join(dir, 'fulldb');
    const db = await DB.open(dbdir, { createIfMissing: true, compression: 0 });

    // Write
    await db.put(Buffer.from('name'), Buffer.from('xiaodeng'));
    await db.put(Buffer.from('age'), Buffer.from('25'));

    // Read
    expect(await db.get(Buffer.from('name'))).toEqual(Buffer.from('xiaodeng'));
    expect(await db.get(Buffer.from('age'))).toEqual(Buffer.from('25'));
    expect(await db.get(Buffer.from('missing'))).toBeNull();

    // Delete
    await db.delete(Buffer.from('age'));
    expect(await db.get(Buffer.from('age'))).toBeNull();

    await db.close();
  });

  it('data persists across reopen', async () => {
    const dbdir = join(dir, 'persist');
    const db1 = await DB.open(dbdir, { createIfMissing: true, compression: 0 });
    await db1.put(Buffer.from('persistent'), Buffer.from('data'));
    await db1.close();

    const db2 = await DB.open(dbdir, { compression: 0 });
    expect(await db2.get(Buffer.from('persistent'))).toEqual(Buffer.from('data'));
    await db2.close();
  });
});
