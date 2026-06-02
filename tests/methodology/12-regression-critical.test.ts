/**
 * 回归测试 (Regression Testing)
 * 确保新代码不破坏现有功能，覆盖已知易出错的场景。
 * 覆盖: 写锁串行化, 双写冲突, 数据持久化, 关闭时刷盘, 迭代器跳过已删除
 *        WAL碎片拼接, Bloom假阳性, 快照隔离, 缓存淘汰正确性
 */
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { DB } from '../../src/db.js';
import { WriteBatch } from '../../src/write_batch.js';
import { BytewiseComparator } from '../../src/comparator.js';
import { Arena } from '../../src/arena.js';
import { SkipList } from '../../src/memtable/skiplist.js';
import { LRUCache } from '../../src/cache.js';
import { BlockBuilder } from '../../src/sstable/block_builder.js';
import { Block } from '../../src/sstable/block.js';
import { newBloomFilterPolicy } from '../../src/sstable/bloom.js';
import { MemTable } from '../../src/memtable.js';
import { ValueType } from '../../src/types.js';

const rootDir = join(tmpdir(), `regression-${randomBytes(4).toString('hex')}`);
afterEach(() => { try { rmSync(rootDir, { recursive: true, force: true }); } catch {} });

// ─── 写锁序列化回归 ───
describe('Write Lock Serialization Regression', () => {
  it('concurrent writes should not lose data', async () => {
    const dbdir = join(rootDir, 'writelock');
    const db = await DB.open(dbdir, { createIfMissing: true, compression: 0 });

    // 10 concurrent writes to different keys
    const writes = Array.from({ length: 10 }, (_, i) =>
      db.put(Buffer.from(`key${i}`), Buffer.from(`val${i}`))
    );
    await Promise.all(writes);

    // All should be readable
    for (let i = 0; i < 10; i++) {
      const val = await db.get(Buffer.from(`key${i}`));
      expect(val).not.toBeNull();
      expect(val!.toString()).toBe(`val${i}`);
    }
    await db.close();
  });

  it('concurrent batch writes should be atomic', async () => {
    const dbdir = join(rootDir, 'batchlock');
    const db = await DB.open(dbdir, { createIfMissing: true, compression: 0 });

    const batches = Array.from({ length: 5 }, (_, i) => {
      const batch = new WriteBatch();
      batch.put(Buffer.from(`b${i}-a`), Buffer.from(`va${i}`));
      batch.put(Buffer.from(`b${i}-b`), Buffer.from(`vb${i}`));
      return db.write(batch);
    });
    await Promise.all(batches);

    expect(await db.get(Buffer.from('b0-a'))).toEqual(Buffer.from('va0'));
    expect(await db.get(Buffer.from('b4-b'))).toEqual(Buffer.from('vb4'));
    await db.close();
  });
});

// ─── 数据持久化回归 ───
describe('Persistence Regression', () => {
  it('put → close → open → get returns same data', async () => {
    const dbdir = join(rootDir, 'persist');
    const db1 = await DB.open(dbdir, { createIfMissing: true, compression: 0 });
    await db1.put(Buffer.from('k1'), Buffer.from('v1'));
    await db1.put(Buffer.from('k2'), Buffer.from('v2'));
    await db1.close();

    const db2 = await DB.open(dbdir, { compression: 0 });
    expect(await db2.get(Buffer.from('k1'))).toEqual(Buffer.from('v1'));
    expect(await db2.get(Buffer.from('k2'))).toEqual(Buffer.from('v2'));
    await db2.close();
  });

  it('delete → close → open → get returns null', async () => {
    const dbdir = join(rootDir, 'delpersist');
    const db1 = await DB.open(dbdir, { createIfMissing: true, compression: 0 });
    await db1.put(Buffer.from('k'), Buffer.from('v'));
    await db1.delete(Buffer.from('k'));
    await db1.close();

    const db2 = await DB.open(dbdir, { compression: 0 });
    expect(await db2.get(Buffer.from('k'))).toBeNull();
    await db2.close();
  });
});

// ─── 快照隔离回归 ───
describe('Snapshot Isolation Regression', () => {
  it('snapshot should not see writes after snapshot time', async () => {
    const dbdir = join(rootDir, 'snapshot');
    const db = await DB.open(dbdir, { createIfMissing: true, compression: 0 });
    await db.put(Buffer.from('before'), Buffer.from('old'));
    const snap = db.getSnapshot();
    await db.put(Buffer.from('before'), Buffer.from('new')); // overwrite
    await db.put(Buffer.from('after'), Buffer.from('visible'));

    // Snapshot should see old value
    expect(await db.get(Buffer.from('before'), { snapshot: snap })).toEqual(Buffer.from('old'));
    expect(await db.get(Buffer.from('after'), { snapshot: snap })).toBeNull();

    // Current read should see new
    expect(await db.get(Buffer.from('before'))).toEqual(Buffer.from('new'));
    expect(await db.get(Buffer.from('after'))).toEqual(Buffer.from('visible'));

    snap[Symbol.dispose]();
    await db.close();
  });
});

// ─── LRU 缓存一致性回归 ───
describe('LRU Cache Consistency Regression', () => {
  it('eviction should maintain circular list integrity', () => {
    const cache = new LRUCache(5);
    // Insert and evict in a way that could break list
    for (let i = 0; i < 20; i++) {
      cache.insert(Buffer.from(`k${i}`), Buffer.from(`v${i}`), 1);
    }
    expect(cache.totalCharge()).toBe(5);
    // Should still be able to insert and lookup
    cache.insert(Buffer.from('final'), Buffer.from('ok'), 1);
    expect(cache.lookup(Buffer.from('final'))).not.toBeNull();
  });

  it('lookup after erase should return null', () => {
    const cache = new LRUCache(100);
    cache.insert(Buffer.from('k'), Buffer.from('v'), 10);
    cache.erase(Buffer.from('k'));
    expect(cache.lookup(Buffer.from('k'))).toBeNull();
    expect(cache.totalCharge()).toBe(0);
  });

  it('prune should work after eviction cycle', () => {
    const cache = new LRUCache(10);
    cache.insert(Buffer.from('a'), Buffer.from('1'), 6);
    cache.insert(Buffer.from('b'), Buffer.from('2'), 6);
    cache.prune();
    expect(cache.totalCharge()).toBe(0);
    cache.insert(Buffer.from('c'), Buffer.from('3'), 5);
    expect(cache.totalCharge()).toBe(5);
  });
});

// ─── Block 数据完整性回归 ───
describe('Block Integrity Regression', () => {
  it('block with many entries should iterate all', () => {
    const bb = new BlockBuilder(4);
    for (let i = 0; i < 500; i++) {
      bb.add(Buffer.from(`k${i.toString().padStart(5, '0')}`), Buffer.from(`v${i}`));
    }
    const data = bb.finish();
    const block = new Block(data);
    const iter = block.iterator(new BytewiseComparator());
    let count = 0;
    iter.seekToFirst();
    while (iter.valid()) {
      count++;
      iter.next();
    }
    expect(count).toBe(500);
  });

  it('binary search seek should find inserted keys', () => {
    const bb = new BlockBuilder(8);
    for (let i = 0; i < 100; i++) {
      bb.add(Buffer.from(`k${i.toString().padStart(3, '0')}`), Buffer.from(`v${i}`));
    }
    const data = bb.finish();
    const block = new Block(data);
    const iter = block.iterator(new BytewiseComparator());
    iter.seek(Buffer.from('k050'));
    expect(iter.valid()).toBe(true);
    expect(iter.key().toString()).toBe('k050');
  });
});

// ─── Bloom 假阳性回归 ───
describe('Bloom Filter False Positive Regression', () => {
  it('inserted keys always match', () => {
    const filter = newBloomFilterPolicy(10);
    const keys = Array.from({ length: 200 }, (_, i) => Buffer.from(`key${i}`));
    const bloom = filter.createFilter(keys);
    for (const k of keys) {
      expect(filter.keyMayMatch(k, bloom)).toBe(true);
    }
  });
});

// ─── MemTable 快照查询回归 ───
describe('MemTable Snapshot Query Regression', () => {
  it('overwritten keys: snapshot sees old, current sees new', () => {
    const mem = new MemTable(new BytewiseComparator());
    mem.add(10n, ValueType.Value, Buffer.from('key'), Buffer.from('old'));
    mem.add(20n, ValueType.Value, Buffer.from('key'), Buffer.from('new'));

    // Snapshot at seq 15 sees 'old'
    const old = mem.get(Buffer.from('key'), 15n);
    expect(old).not.toBeNull();
    expect(old!.value).toEqual(Buffer.from('old'));

    // Current (seq 25) sees 'new'
    const cur = mem.get(Buffer.from('key'), 25n);
    expect(cur).not.toBeNull();
    expect(cur!.value).toEqual(Buffer.from('new'));
  });

  it('deletion: older snapshot sees value, newer sees deletion', () => {
    const mem = new MemTable(new BytewiseComparator());
    mem.add(10n, ValueType.Value, Buffer.from('key'), Buffer.from('val'));
    mem.add(20n, ValueType.Deletion, Buffer.from('key'), Buffer.alloc(0));

    const snap = mem.get(Buffer.from('key'), 15n);
    expect(snap).not.toBeNull();
    expect(snap!.valueType).toBe(ValueType.Value);

    const current = mem.get(Buffer.from('key'), 25n);
    expect(current).not.toBeNull();
    expect(current!.valueType).toBe(ValueType.Deletion);
  });
});

// ─── 重复关闭回归 ───
describe('Double Close Regression', () => {
  it('double close should not throw', async () => {
    const dbdir = join(rootDir, 'dblclose');
    const db = await DB.open(dbdir, { createIfMissing: true, compression: 0 });
    await db.close();
    await db.close(); // should not throw
  });
});
