/**
 * 状态转换测试 (State Transition Testing)
 * 测试关键对象的状态机和状态间转换。
 * 覆盖: BlockBuilder(open→finished), TableBuilder(open→finished),
 *        Snapshot(active→disposed), DB(open→closed), Iterator,
 *        LRUCache(empty→partial→full→evicted), WriteBatch(empty→dirty→cleared)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { BlockBuilder } from '../../src/sstable/block_builder.js';
import { TableBuilder } from '../../src/sstable/table_builder.js';
import { defaultDBOptions } from '../../src/options.js';
import { Snapshot } from '../../src/snapshot.js';
import { LRUCache } from '../../src/cache.js';
import { WriteBatch } from '../../src/write_batch.js';
import { Arena } from '../../src/arena.js';
import { SkipList } from '../../src/memtable/skiplist.js';
import { BytewiseComparator } from '../../src/comparator.js';
import { DB } from '../../src/db.js';

// ─── BlockBuilder 状态机 ───
// States: Open → Finished
describe('BlockBuilder State Transition', () => {
  it('Open → Finished: finish() transitions and prevents double-finish', () => {
    const bb = new BlockBuilder(16);
    bb.add(Buffer.from('k'), Buffer.from('v'));
    bb.finish();
    expect(() => bb.finish()).toThrow('already finished');
  });

  it('Open → Finished: finish() on empty builder succeeds', () => {
    const bb = new BlockBuilder(16);
    expect(() => bb.finish()).not.toThrow();
  });

  it('Open state: can call add and estimatedSize', () => {
    const bb = new BlockBuilder(16);
    expect(bb.estimatedSize()).toBe(0);
    bb.add(Buffer.from('k'), Buffer.from('v'));
    expect(bb.estimatedSize()).toBeGreaterThan(0);
  });
});

// ─── TableBuilder 状态机 ───
describe('TableBuilder State Transition', () => {
  const baseDir = join(tmpdir(), `tb-state-${randomBytes(4).toString('hex')}`);
  beforeEach(() => { mkdirSync(baseDir, { recursive: true }); });
  afterEach(() => { try { rmSync(baseDir, { recursive: true, force: true }); } catch {} });

  it('Open → Finished: normal transition', () => {
    const fp = join(baseDir, 'test.ldb');
    const tb = new TableBuilder(fp, { ...defaultDBOptions(), compression: 0 });
    tb.add(Buffer.from('k'), Buffer.from('v'));
    tb.finish();
    expect(existsSync(fp)).toBe(true);
  });

  it('Open → Finished: empty table succeeds', () => {
    const fp = join(baseDir, 'empty.ldb');
    const tb = new TableBuilder(fp, { ...defaultDBOptions(), compression: 0 });
    expect(() => tb.finish()).not.toThrow();
  });

  it('Finished state: cannot add or re-finish', () => {
    const fp = join(baseDir, 'double.ldb');
    const tb = new TableBuilder(fp, { ...defaultDBOptions(), compression: 0 });
    tb.finish();
    expect(() => tb.add(Buffer.from('k'), Buffer.from('v'))).toThrow();
    expect(() => tb.finish()).toThrow();
  });

  it('Open → (data block flush) → Finished', () => {
    const fp = join(baseDir, 'multi.ldb');
    const tb = new TableBuilder(fp, { ...defaultDBOptions(), compression: 0, blockSize: 100 });
    for (let i = 0; i < 50; i++) {
      tb.add(Buffer.from(`key${i.toString().padStart(4, '0')}`), Buffer.from(`val${i}`));
    }
    tb.finish();
    expect(existsSync(fp)).toBe(true);
  });
});

// ─── Snapshot 状态机 ───
// States: Active → Disposed
describe('Snapshot State Transition', () => {
  it('Active → Disposed: Symbol.dispose transitions', () => {
    const snap = new Snapshot(100n);
    expect(snap.sequence).toBe(100n);
    snap[Symbol.dispose]();
    // Disposed state: no observable change except onRelease called
    // Can't re-dispose with any effect
    snap[Symbol.dispose](); // should not throw
  });

  it('Active: sequence is readable', () => {
    const snap = new Snapshot(42n);
    expect(snap.sequence).toBe(42n);
  });

  it('Disposed: second dispose does not re-trigger callback', () => {
    let count = 0;
    const snap = new Snapshot(1n, () => { count++; });
    snap[Symbol.dispose]();
    expect(count).toBe(1);
    snap[Symbol.dispose]();
    expect(count).toBe(1); // still 1
  });
});

// ─── LRUCache 状态机 ───
// States: Empty → PartiallyFilled → Full(Evicting) → Pruned(Empty)
describe('LRUCache State Transition', () => {
  it('Empty → PartiallyFilled: insert adds entries', () => {
    const cache = new LRUCache(100);
    expect(cache.totalCharge()).toBe(0);
    cache.insert(Buffer.from('a'), Buffer.from('1'), 30);
    expect(cache.totalCharge()).toBe(30);
  });

  it('PartiallyFilled → Full: further inserts trigger eviction', () => {
    const cache = new LRUCache(50);
    cache.insert(Buffer.from('a'), Buffer.from('1'), 30);
    cache.insert(Buffer.from('b'), Buffer.from('2'), 30);
    expect(cache.totalCharge()).toBeLessThanOrEqual(50);
    expect(cache.lookup(Buffer.from('a'))).toBeNull(); // evicted
  });

  it('Full → Pruned: prune empties the cache', () => {
    const cache = new LRUCache(100);
    cache.insert(Buffer.from('a'), Buffer.from('1'), 50);
    cache.insert(Buffer.from('b'), Buffer.from('2'), 50);
    cache.prune();
    expect(cache.totalCharge()).toBe(0);
    expect(cache.lookup(Buffer.from('a'))).toBeNull();
  });

  it('PartiallyFilled → Empty: after erase all', () => {
    const cache = new LRUCache(100);
    cache.insert(Buffer.from('a'), Buffer.from('1'), 10);
    cache.insert(Buffer.from('b'), Buffer.from('2'), 10);
    cache.erase(Buffer.from('a'));
    cache.erase(Buffer.from('b'));
    expect(cache.totalCharge()).toBe(0);
  });

  it('lookup promotes entry (LRU order change)', () => {
    const cache = new LRUCache(25);
    cache.insert(Buffer.from('a'), Buffer.from('1'), 10);
    cache.insert(Buffer.from('b'), Buffer.from('2'), 10);
    cache.lookup(Buffer.from('a')); // promote 'a'
    cache.insert(Buffer.from('c'), Buffer.from('3'), 10);
    // 'b' should be evicted, not 'a'
    expect(cache.lookup(Buffer.from('a'))).not.toBeNull();
    expect(cache.lookup(Buffer.from('b'))).toBeNull();
  });
});

// ─── WriteBatch 状态机 ───
// States: Empty → Dirty → Cleared
describe('WriteBatch State Transition', () => {
  it('Empty: initial state', () => {
    const batch = new WriteBatch();
    expect(batch.approxSize()).toBe(0);
  });

  it('Empty → Dirty: put adds entries', () => {
    const batch = new WriteBatch();
    batch.put(Buffer.from('k'), Buffer.from('v'));
    expect(batch.approxSize()).toBeGreaterThan(0);
  });

  it('Empty → Dirty: delete adds entries', () => {
    const batch = new WriteBatch();
    batch.delete(Buffer.from('k'));
    expect(batch.approxSize()).toBeGreaterThan(0);
  });

  it('Dirty → Cleared: clear resets', () => {
    const batch = new WriteBatch();
    batch.put(Buffer.from('k1'), Buffer.from('v1'));
    batch.put(Buffer.from('k2'), Buffer.from('v2'));
    batch.clear();
    expect(batch.approxSize()).toBe(0);
    let count = 0;
    batch.iterate(() => { count++; });
    expect(count).toBe(0);
  });

  it('Dirty → Dirty: append merges', () => {
    const a = new WriteBatch();
    a.put(Buffer.from('a'), Buffer.from('1'));
    const b = new WriteBatch();
    b.put(Buffer.from('b'), Buffer.from('2'));
    const sizeBefore = a.approxSize();
    a.append(b);
    expect(a.approxSize()).toBeGreaterThan(sizeBefore);
  });

  it('Cleared → Dirty: can add after clear', () => {
    const batch = new WriteBatch();
    batch.put(Buffer.from('k'), Buffer.from('v'));
    batch.clear();
    batch.put(Buffer.from('k2'), Buffer.from('v2'));
    expect(batch.approxSize()).toBeGreaterThan(0);
  });
});

// ─── SkipList 迭代器状态机 ───
describe('SkipList Iterator State Transition', () => {
  let arena: Arena;
  let list: SkipList;

  beforeEach(() => {
    arena = new Arena();
    list = new SkipList(new BytewiseComparator(), arena);
  });

  it('Empty list: not valid, seek is no-op', () => {
    const iter = list.iterator();
    expect(iter.valid()).toBe(false);
    iter.seekToFirst();
    expect(iter.valid()).toBe(false);
  });

  it('seekToFirst → valid entries → next → invalid at end', () => {
    list.insert(Buffer.from('a'), Buffer.from('1'));
    list.insert(Buffer.from('b'), Buffer.from('2'));
    const iter = list.iterator();
    iter.seekToFirst();
    expect(iter.valid()).toBe(true);
    expect(iter.key()).toEqual(Buffer.from('a'));
    iter.next();
    expect(iter.valid()).toBe(true);
    expect(iter.key()).toEqual(Buffer.from('b'));
    iter.next();
    expect(iter.valid()).toBe(false);
  });
});

// ─── DB 状态机 ───
// States: Opened → (Writes) → Compacting → Closed
describe('DB Open/Close State Transition', () => {
  it('Open → Close: clean shutdown', async () => {
    const dir = join(tmpdir(), `db-state-${randomBytes(4).toString('hex')}`);
    try {
      const db = await DB.open(dir, { createIfMissing: true, compression: 0 });
      db.put(Buffer.from('key'), Buffer.from('value'));
      await db.close();
      expect(existsSync(dir)).toBe(true);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it('Open → Close: should not throw on double close', async () => {
    const dir = join(tmpdir(), `db-close-${randomBytes(4).toString('hex')}`);
    try {
      const db = await DB.open(dir, { createIfMissing: true, compression: 0 });
      await db.close();
      await db.close(); // should not throw
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it('Open → Write → Close: data persists', async () => {
    const dir = join(tmpdir(), `db-write-${randomBytes(4).toString('hex')}`);
    try {
      const db = await DB.open(dir, { createIfMissing: true, compression: 0 });
      await db.put(Buffer.from('hello'), Buffer.from('world'));
      await db.close();

      const db2 = await DB.open(dir, { compression: 0 });
      const val = await db2.get(Buffer.from('hello'));
      expect(val).not.toBeNull();
      expect(val!).toEqual(Buffer.from('world'));
      await db2.close();
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});
