/**
 * 负载与压力测试 (Load & Stress Testing)
 * 模拟预期负载和找出系统瓶颈。
 * 覆盖: 大量写入吞吐, 大量读取, 大数据集, 大键值对, 内存压力
 */
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { DB } from '../../src/db.js';
import { WriteBatch } from '../../src/write_batch.js';
import { Arena } from '../../src/arena.js';
import { SkipList } from '../../src/memtable/skiplist.js';
import { BytewiseComparator } from '../../src/comparator.js';
import { LRUCache } from '../../src/cache.js';
import { BlockBuilder } from '../../src/sstable/block_builder.js';
import { Block } from '../../src/sstable/block.js';

const rootDir = join(tmpdir(), `stresstest-${randomBytes(4).toString('hex')}`);
afterEach(() => { try { rmSync(rootDir, { recursive: true, force: true }); } catch {} });

// ─── 大量写入负载 ───
describe('Write Load Test', () => {
  it('should handle 100 sequential puts', async () => {
    const dbdir = join(rootDir, 'bulkwrite');
    const db = await DB.open(dbdir, { createIfMissing: true, compression: 0 });
    const N = 100;
    for (let i = 0; i < N; i++) {
      await db.put(
        Buffer.from(`key${i.toString().padStart(4, '0')}`),
        Buffer.from(`value${i.toString().padStart(4, '0')}`)
      );
    }
    // Verify all
    for (let i = 0; i < N; i++) {
      const val = await db.get(Buffer.from(`key${i.toString().padStart(4, '0')}`));
      expect(val).not.toBeNull();
    }
    await db.close();
  }, 30000);

  it('should handle batch write of 50 entries', async () => {
    const dbdir = join(rootDir, 'batchload');
    const db = await DB.open(dbdir, { createIfMissing: true, compression: 0 });
    const batch = new WriteBatch();
    for (let i = 0; i < 50; i++) {
      batch.put(Buffer.from(`b${i}`), Buffer.from(`v${i}`));
    }
    await db.write(batch);
    expect(await db.get(Buffer.from('b0'))).toEqual(Buffer.from('v0'));
    expect(await db.get(Buffer.from('b49'))).toEqual(Buffer.from('v49'));
    await db.close();
  });

  it('should handle large values (100KB)', async () => {
    const dbdir = join(rootDir, 'largeval');
    const db = await DB.open(dbdir, { createIfMissing: true, compression: 0 });
    const bigValue = Buffer.alloc(100 * 1024, 0x42);
    await db.put(Buffer.from('big'), bigValue);
    const result = await db.get(Buffer.from('big'));
    expect(result).not.toBeNull();
    expect(result!.length).toBe(bigValue.length);
    expect(result![0]).toBe(0x42);
    expect(result![result!.length - 1]).toBe(0x42);
    await db.close();
  }, 15000);
});

// ─── 内存压力测试 ───
describe('Memory Stress Test', () => {
  it('SkipList: should handle 5000 entries without memory issues', () => {
    const arena = new Arena();
    const list = new SkipList(new BytewiseComparator(), arena);
    for (let i = 0; i < 5000; i++) {
      list.insert(
        Buffer.from(`skey${i.toString().padStart(6, '0')}`),
        Buffer.from(`sval${i}`)
      );
    }
    expect(list.find(Buffer.from('skey000000'))).not.toBeNull();
    expect(list.find(Buffer.from('skey004999'))).not.toBeNull();

    // Verify order
    const iter = list.iterator();
    iter.seekToFirst();
    let count = 0;
    while (iter.valid()) { count++; iter.next(); }
    expect(count).toBe(5000);
  });

  it('BlockBuilder: should handle many entries', () => {
    const bb = new BlockBuilder(16);
    for (let i = 0; i < 2000; i++) {
      bb.add(
        Buffer.from(`k${i.toString().padStart(6, '0')}`),
        Buffer.from(`v${i}`)
      );
    }
    const data = bb.finish();
    expect(data.length).toBeGreaterThan(0);

    const block = new Block(data);
    const iter = block.iterator(new BytewiseComparator());
    let count = 0;
    for (iter.seekToFirst(); iter.valid(); iter.next()) count++;
    expect(count).toBe(2000);
  });

  it('LRUCache: should handle full capacity sustained load', () => {
    const cache = new LRUCache(100);
    // Constantly insert and lookup to exercise list operations
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 50; i++) {
        cache.insert(Buffer.from(`r${round}k${i}`), Buffer.from(`v${i}`), 2);
      }
      // Lookup should always succeed for latest entries
      for (let i = 0; i < 10; i++) {
        cache.lookup(Buffer.from(`r${round}k${i}`));
      }
    }
    expect(cache.totalCharge()).toBeLessThanOrEqual(100);
  });
});

// ─── 读取负载测试 ───
describe('Read Load Test', () => {
  it('should handle 100 sequential gets after writes', async () => {
    const dbdir = join(rootDir, 'readload');
    const db = await DB.open(dbdir, { createIfMissing: true, compression: 0 });
    const N = 100;
    for (let i = 0; i < N; i++) {
      await db.put(Buffer.from(`key${i}`), Buffer.from(`value${i}`));
    }
    // Read all sequentially
    for (let i = 0; i < N; i++) {
      const val = await db.get(Buffer.from(`key${i}`));
      expect(val).not.toBeNull();
    }
    await db.close();
  }, 15000);

  it('should return null efficiently for missing keys', async () => {
    const dbdir = join(rootDir, 'missload');
    const db = await DB.open(dbdir, { createIfMissing: true, compression: 0 });
    for (let i = 0; i < 50; i++) {
      expect(await db.get(Buffer.from(`missing${i}`))).toBeNull();
    }
    await db.close();
  });
});

// ─── 随机模式负载 ───
describe('Random Access Pattern Load', () => {
  it('should handle interleaved reads and writes', async () => {
    const dbdir = join(rootDir, 'mixed');
    const db = await DB.open(dbdir, { createIfMissing: true, compression: 0 });

    for (let i = 0; i < 30; i++) {
      if (i % 2 === 0) {
        await db.put(Buffer.from(`k${i}`), Buffer.from(`v${i}`));
      } else {
        await db.get(Buffer.from(`k${i - 1}`)); // read previous
      }
    }
    // All written keys should exist
    for (let i = 0; i < 30; i += 2) {
      const val = await db.get(Buffer.from(`k${i}`));
      expect(val).not.toBeNull();
    }
    await db.close();
  });
});
