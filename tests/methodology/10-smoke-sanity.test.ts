/**
 * 冒烟与健全性测试 (Smoke & Sanity Testing)
 * 快速验证核心功能是否正常工作。每个测试应 < 100ms。
 * 覆盖: DB open/put/get/delete, Status, WriteBatch, CRC, Bloom, SkipList 最基础路径
 */
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { DB } from '../../src/db.js';
import { WriteBatch } from '../../src/write_batch.js';
import { Status } from '../../src/status.js';
import { crc32 } from '../../src/codec.js';
import { BytewiseComparator } from '../../src/comparator.js';
import { Arena } from '../../src/arena.js';
import { SkipList } from '../../src/memtable/skiplist.js';
import { newBloomFilterPolicy } from '../../src/sstable/bloom.js';

// ─── 核心 DB 操作冒烟测试 ───
describe('DB Smoke Test', () => {
  const dir = join(tmpdir(), `smoke-${randomBytes(4).toString('hex')}`);

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('should open/create DB', async () => {
    const db = await DB.open(dir, { createIfMissing: true, compression: 0 });
    expect(db).toBeDefined();
    await db.close();
  });

  it('should put and get a value', async () => {
    const db = await DB.open(dir, { createIfMissing: true, compression: 0 });
    await db.put(Buffer.from('hello'), Buffer.from('world'));
    const val = await db.get(Buffer.from('hello'));
    expect(val).toEqual(Buffer.from('world'));
    await db.close();
  });

  it('should return null for missing key', async () => {
    const db = await DB.open(dir, { createIfMissing: true, compression: 0 });
    const val = await db.get(Buffer.from('nonexistent'));
    expect(val).toBeNull();
    await db.close();
  });

  it('should delete a key', async () => {
    const db = await DB.open(dir, { createIfMissing: true, compression: 0 });
    await db.put(Buffer.from('key'), Buffer.from('value'));
    await db.delete(Buffer.from('key'));
    const val = await db.get(Buffer.from('key'));
    expect(val).toBeNull();
    await db.close();
  });

  it('should handle WriteBatch', async () => {
    const db = await DB.open(dir, { createIfMissing: true, compression: 0 });
    const batch = new WriteBatch();
    batch.put(Buffer.from('a'), Buffer.from('1'));
    batch.put(Buffer.from('b'), Buffer.from('2'));
    batch.delete(Buffer.from('c'));
    await db.write(batch);
    expect(await db.get(Buffer.from('a'))).toEqual(Buffer.from('1'));
    expect(await db.get(Buffer.from('b'))).toEqual(Buffer.from('2'));
    await db.close();
  });

  it('should get snapshot', async () => {
    const db = await DB.open(dir, { createIfMissing: true, compression: 0 });
    await db.put(Buffer.from('before'), Buffer.from('snapshot'));
    const snap = db.getSnapshot();
    await db.put(Buffer.from('after'), Buffer.from('value'));
    // Reading with snapshot should NOT see 'after'
    const val = await db.get(Buffer.from('after'), { snapshot: snap });
    expect(val).toBeNull();
    snap[Symbol.dispose]();
    await db.close();
  });

  it('should iterate over keys', async () => {
    const db = await DB.open(dir, { createIfMissing: true, compression: 0 });
    await db.put(Buffer.from('a'), Buffer.from('1'));
    await db.put(Buffer.from('b'), Buffer.from('2'));
    await db.put(Buffer.from('c'), Buffer.from('3'));
    const iter = db.iterator();
    await iter.seekToFirst();
    const keys: Buffer[] = [];
    while (iter.valid()) {
      keys.push(iter.key());
      await iter.next();
    }
    expect(keys).toHaveLength(3);
    await db.close();
  });
});

// ─── 基础组件健全性测试 ───
describe('Component Sanity Test', () => {
  it('CRC32: deterministic output', () => {
    expect(crc32(Buffer.from('test'))).toBe(crc32(Buffer.from('test')));
  });

  it('Status: basic operations', () => {
    expect(Status.ok().ok()).toBe(true);
    expect(Status.notFound('x').isNotFound()).toBe(true);
  });

  it('SkipList: insert and find', () => {
    const arena = new Arena();
    const list = new SkipList(new BytewiseComparator(), arena);
    list.insert(Buffer.from('key'), Buffer.from('val'));
    expect(list.find(Buffer.from('key'))).not.toBeNull();
    expect(list.find(Buffer.from('missing'))).toBeNull();
  });

  it('Bloom: filter basics', () => {
    const filter = newBloomFilterPolicy(10);
    const bloom = filter.createFilter([Buffer.from('hello')]);
    expect(filter.keyMayMatch(Buffer.from('hello'), bloom)).toBe(true);
  });

  it('WriteBatch: encode/decode', () => {
    const batch = new WriteBatch();
    batch.put(Buffer.from('k'), Buffer.from('v'));
    const decoded = WriteBatch.decode(batch.encode());
    expect(decoded.approxSize()).toBe(batch.approxSize());
  });
});
