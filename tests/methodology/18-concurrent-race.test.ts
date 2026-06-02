/**
 * 并发与竞态测试 (Concurrency & Race Condition Testing)
 * 验证多客户端并发操作时的正确性与数据一致性。
 * 覆盖: DB并发写入, 并发读写, Snapshot并发, Iterator并发, LRU并发
 */
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { randomBytes, randomInt } from 'node:crypto';
import { DB } from '../../src/db.js';
import { WriteBatch } from '../../src/write_batch.js';
import { LRUCache } from '../../src/cache.js';
import { Arena } from '../../src/arena.js';
import { SkipList } from '../../src/memtable/skiplist.js';
import { BytewiseComparator } from '../../src/comparator.js';

const rootDir = join(tmpdir(), `concurrent-${randomBytes(4).toString('hex')}`);
afterEach(() => { try { rmSync(rootDir, { recursive: true, force: true }); } catch {} });

// ─── 并发写入不同键 ───
describe('Concurrent Writes (Different Keys)', () => {
  it('should write all keys without data loss', async () => {
    const dbdir = join(rootDir, 'conwrite');
    const db = await DB.open(dbdir, { createIfMissing: true, compression: 0 });
    const N = 20;

    const writes = Array.from({ length: N }, (_, i) =>
      db.put(Buffer.from(`key${i}`), Buffer.from(`val${i}`))
    );
    await Promise.all(writes);

    // Verify all
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => db.get(Buffer.from(`key${i}`)))
    );
    for (let i = 0; i < N; i++) {
      expect(results[i]).not.toBeNull();
      expect(results[i]!.toString()).toBe(`val${i}`);
    }
    await db.close();
  }, 15000);
});

// ─── 并发写入相同键 ───
describe('Concurrent Writes (Same Key)', () => {
  it('should serialize writes to same key', async () => {
    const dbdir = join(rootDir, 'samekey');
    const db = await DB.open(dbdir, { createIfMissing: true, compression: 0 });
    const N = 10;

    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        db.put(Buffer.from('counter'), Buffer.from(String(i)))
      )
    );

    // All writes should have completed, final value is one of them
    const val = await db.get(Buffer.from('counter'));
    expect(val).not.toBeNull();
    // Final value should be valid integer 0-9
    const n = parseInt(val!.toString());
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThan(10);

    await db.close();
  });
});

// ─── 并发读写 ───
describe('Concurrent Read/Write', () => {
  it('should handle interleaved reads and writes', async () => {
    const dbdir = join(rootDir, 'rw');
    const db = await DB.open(dbdir, { createIfMissing: true, compression: 0 });

    // Pre-populate
    for (let i = 0; i < 10; i++) {
      await db.put(Buffer.from(`base${i}`), Buffer.from(`val${i}`));
    }

    // Concurrent reads of base keys + writes of new keys
    const reads = Array.from({ length: 10 }, (_, i) =>
      db.get(Buffer.from(`base${i}`))
    );
    const writes = Array.from({ length: 5 }, (_, i) =>
      db.put(Buffer.from(`new${i}`), Buffer.from(`nv${i}`))
    );

    const [readResults] = await Promise.all([
      Promise.all(reads),
      Promise.all(writes),
    ]);

    for (const r of readResults) {
      expect(r).not.toBeNull();
    }
    await db.close();
  });
});

// ─── 并发快照 ───
describe('Concurrent Snapshots', () => {
  it('should handle multiple concurrent snapshots', async () => {
    const dbdir = join(rootDir, 'snaps');
    const db = await DB.open(dbdir, { createIfMissing: true, compression: 0 });

    await db.put(Buffer.from('data'), Buffer.from('v0'));

    const snaps = Array.from({ length: 5 }, () => db.getSnapshot());

    await db.put(Buffer.from('data'), Buffer.from('v1'));
    await db.put(Buffer.from('newdata'), Buffer.from('new'));

    // All snapshots should see v0
    for (const snap of snaps) {
      const v = await db.get(Buffer.from('data'), { snapshot: snap });
      expect(v).toEqual(Buffer.from('v0'));
      const n = await db.get(Buffer.from('newdata'), { snapshot: snap });
      expect(n).toBeNull();
      snap[Symbol.dispose]();
    }

    // Current should see latest
    expect(await db.get(Buffer.from('data'))).toEqual(Buffer.from('v1'));
    expect(await db.get(Buffer.from('newdata'))).toEqual(Buffer.from('new'));

    await db.close();
  });
});

// ─── 并发迭代 ───
describe('Concurrent Iteration', () => {
  it('should handle iteration while writing', async () => {
    const dbdir = join(rootDir, 'coniter');
    const db = await DB.open(dbdir, { createIfMissing: true, compression: 0 });

    // Seed data
    for (let i = 0; i < 20; i++) {
      await db.put(Buffer.from(`seed${i}`), Buffer.from(`sv${i}`));
    }

    const iter = db.iterator();
    await iter.seekToFirst();

    // Write more while iterating
    await db.put(Buffer.from('during'), Buffer.from('iteration'));

    // Read current iteration state
    let hasKeys = false;
    if (iter.valid()) {
      const k = iter.key();
      expect(k).toBeInstanceOf(Buffer);
      hasKeys = true;
    }
    expect(hasKeys).toBe(true);

    await db.close();
  });
});

// ─── LRU 并发访问 ───
describe('LRU Concurrent Access', () => {
  it('should handle rapid sequential access (simulating concurrent)', () => {
    const cache = new LRUCache(100);
    // Rapid insert/lookup pattern
    for (let round = 0; round < 10; round++) {
      // Burst of inserts
      for (let i = 0; i < 20; i++) {
        cache.insert(Buffer.from(`k${round * 20 + i}`), Buffer.from(`v${i}`), 2);
      }
      // Burst of lookups
      for (let i = 0; i < 10; i++) {
        cache.lookup(Buffer.from(`k${round * 20 + i}`));
      }
      // Erase some
      for (let i = 0; i < 5; i++) {
        cache.erase(Buffer.from(`k${round * 20 + i}`));
      }
    }
    // Cache integrity: totalCharge should be consistent
    expect(cache.totalCharge()).toBeLessThanOrEqual(100);
    expect(cache.totalCharge()).toBeGreaterThanOrEqual(0);
  });
});

// ─── DB 并发 Batch 写入 ───
describe('Concurrent Batch Writes', () => {
  it('should handle concurrent WriteBatch executions', async () => {
    const dbdir = join(rootDir, 'conbatch');
    const db = await DB.open(dbdir, { createIfMissing: true, compression: 0 });

    const batches = Array.from({ length: 8 }, (_, n) => {
      const batch = new WriteBatch();
      batch.put(Buffer.from(`batch${n}-a`), Buffer.from(`va${n}`));
      batch.put(Buffer.from(`batch${n}-b`), Buffer.from(`vb${n}`));
      return db.write(batch);
    });

    await Promise.all(batches);

    // Verify
    for (let n = 0; n < 8; n++) {
      expect(await db.get(Buffer.from(`batch${n}-a`))).toEqual(Buffer.from(`va${n}`));
      expect(await db.get(Buffer.from(`batch${n}-b`))).toEqual(Buffer.from(`vb${n}`));
    }
    await db.close();
  }, 15000);
});

// ─── SkipList 并发模式访问 ───
describe('SkipList Concurrent-Style Access', () => {
  it('should handle rapid mixed operations', () => {
    const arena = new Arena();
    const list = new SkipList(new BytewiseComparator(), arena);

    // Insert 100 entries
    for (let i = 0; i < 100; i++) {
      list.insert(Buffer.from(`k${i}`), Buffer.from(`v${i}`));
    }

    // Mixed operations: find, iterate
    for (let round = 0; round < 5; round++) {
      // Finds
      for (let i = 0; i < 20; i++) {
        const idx = randomInt(0, 100);
        const found = list.find(Buffer.from(`k${idx}`));
        if (found) expect(found.value.toString()).toBe(`v${idx}`);
      }
      // Iteration
      const iter = list.iterator();
      iter.seekToFirst();
      let count = 0;
      while (iter.valid()) { count++; iter.next(); }
      expect(count).toBe(100);
    }
  });
});
