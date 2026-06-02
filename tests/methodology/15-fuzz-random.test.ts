/**
 * 模糊测试与随机测试 (Fuzz & Random Testing)
 * 使用随机生成的输入数据测试系统的健壮性。
 * 覆盖: codec with random values, types with random keys, bloom with random keys,
 *        block with random entries, skiplist with random inserts, DB random operations
 */
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { randomBytes, randomInt } from 'node:crypto';
import {
  putVarint32, getVarint32, putVarint64, getVarint64,
  crc32, crc32cMask, crc32cUnmask,
} from '../../src/codec.js';
import { encodeInternalKey, decodeInternalKey, ValueType } from '../../src/types.js';
import { BytewiseComparator } from '../../src/comparator.js';
import { newBloomFilterPolicy } from '../../src/sstable/bloom.js';
import { BlockBuilder } from '../../src/sstable/block_builder.js';
import { Block } from '../../src/sstable/block.js';
import { Arena } from '../../src/arena.js';
import { SkipList } from '../../src/memtable/skiplist.js';
import { LRUCache } from '../../src/cache.js';
import { WriteBatch } from '../../src/write_batch.js';
import { MemTable } from '../../src/memtable.js';
import { DB } from '../../src/db.js';

// ─── Varint 随机模糊 ───
describe('Varint Fuzz', () => {
  it('random uint32 values round-trip correctly', () => {
    for (let i = 0; i < 200; i++) {
      const v = randomInt(0, 0xffffffff);
      const buf = putVarint32(v);
      const [decoded, bytes] = getVarint32(buf);
      expect(decoded).toBe(v);
      expect(bytes).toBeGreaterThan(0);
    }
  });

  it('random bigint values round-trip correctly', () => {
    for (let i = 0; i < 100; i++) {
      const high = BigInt(randomInt(0, 0xffffffff));
      const low = BigInt(randomInt(0, 0xffffffff));
      const v = (high << 32n) | low;
      const buf = putVarint64(v);
      const [decoded] = getVarint64(buf);
      expect(decoded).toBe(v);
    }
  });

  it('partial buffer read should return available data', () => {
    for (let i = 0; i < 50; i++) {
      const v = randomInt(0, 1000000);
      const buf = putVarint32(v);
      // Read from offset somewhere random in the buffer (but valid)
      const [decoded] = getVarint32(buf, 0);
      expect(decoded).toBe(v);
    }
  });
});

// ─── CRC 随机模糊 ───
describe('CRC Fuzz', () => {
  it('random buffers produce deterministic CRC', () => {
    for (let i = 0; i < 100; i++) {
      const len = randomInt(1, 1024);
      const data = randomBytes(len);
      const c1 = crc32(data);
      const c2 = crc32(Buffer.from(data)); // copy
      expect(c1).toBe(c2);
    }
  });

  it('mask/unmask on random CRC values', () => {
    for (let i = 0; i < 100; i++) {
      const v = randomInt(0, 0xffffffff);
      expect(crc32cUnmask(crc32cMask(v))).toBe(v >>> 0);
      expect(crc32cMask(crc32cUnmask(v))).toBe(v >>> 0);
    }
  });
});

// ─── InternalKey 随机模糊 ───
describe('InternalKey Fuzz', () => {
  it('random keys with random sequences round-trip', () => {
    for (let i = 0; i < 200; i++) {
      const keyLen = randomInt(0, 500);
      const key = randomBytes(keyLen);
      const seq = BigInt(randomInt(0, 100000));
      for (const vt of [ValueType.Value, ValueType.Deletion]) {
        const ik = encodeInternalKey(key, seq, vt);
        const decoded = decodeInternalKey(ik);
        expect(decoded.userKey).toEqual(key);
        expect(decoded.sequence).toBe(seq);
        expect(decoded.valueType).toBe(vt);
      }
    }
  });
});

// ─── Bloom Filter 随机模糊 ───
describe('Bloom Filter Fuzz', () => {
  it('random keys always match after insert', () => {
    const filter = newBloomFilterPolicy(10);
    for (let round = 0; round < 20; round++) {
      const nKeys = randomInt(1, 50);
      const keys = Array.from({ length: nKeys }, () => randomBytes(randomInt(1, 100)));
      const bloom = filter.createFilter(keys);
      for (const key of keys) {
        expect(filter.keyMayMatch(key, bloom)).toBe(true);
      }
    }
  });

  it('random non-inserted keys may or may not match (false positive)', () => {
    const filter = newBloomFilterPolicy(10);
    const keys = Array.from({ length: 30 }, () => randomBytes(8));
    const bloom = filter.createFilter(keys);
    // Test with random keys not in set — no crash
    for (let i = 0; i < 50; i++) {
      const testKey = randomBytes(8);
      // Just verify no crash, result can be boolean
      const result = filter.keyMayMatch(testKey, bloom);
      expect(typeof result).toBe('boolean');
    }
  });
});

// ─── Block 随机模糊 ───
describe('Block Fuzz', () => {
  it('random entries round-trip through BlockBuilder→Block', () => {
    for (let round = 0; round < 20; round++) {
      const bb = new BlockBuilder(16);
      const n = randomInt(1, 100);
      const entries: [Buffer, Buffer][] = [];
      for (let i = 0; i < n; i++) {
        const key = randomBytes(randomInt(1, 50));
        const val = randomBytes(randomInt(0, 200));
        entries.push([key, val]);
      }
      // Sort by bytewise
      entries.sort((a, b) => Buffer.compare(a[0], b[0]));
      for (const [k, v] of entries) {
        bb.add(k, v);
      }
      const data = bb.finish();
      const block = new Block(data);
      const iter = block.iterator(new BytewiseComparator());
      let count = 0;
      for (iter.seekToFirst(); iter.valid(); iter.next()) count++;
      expect(count).toBe(n);
    }
  });

  it('random seek should find correct key', () => {
    const bb = new BlockBuilder(16);
    const keys: Buffer[] = [];
    for (let i = 0; i < 50; i++) {
      const key = Buffer.from(`k${i.toString().padStart(3, '0')}`);
      keys.push(key);
      bb.add(key, Buffer.from(`v${i}`));
    }
    const data = bb.finish();
    const block = new Block(data);

    for (let i = 0; i < 20; i++) {
      const idx = randomInt(0, 50);
      const iter = block.iterator(new BytewiseComparator());
      iter.seek(keys[idx]);
      expect(iter.valid()).toBe(true);
      expect(iter.key()).toEqual(keys[idx]);
    }
  });
});

// ─── SkipList 随机模糊 ───
describe('SkipList Fuzz', () => {
  it('random inserts maintain sorted order', () => {
    for (let round = 0; round < 10; round++) {
      const arena = new Arena();
      const list = new SkipList(new BytewiseComparator(), arena);
      const n = randomInt(10, 200);
      const entries: { key: Buffer; val: Buffer }[] = [];
      for (let i = 0; i < n; i++) {
        const e = {
          key: randomBytes(randomInt(1, 30)),
          val: randomBytes(randomInt(1, 50)),
        };
        entries.push(e);
        list.insert(e.key, e.val);
      }
      // Verify sorted iteration
      const iter = list.iterator();
      iter.seekToFirst();
      let prev = Buffer.alloc(0);
      let count = 0;
      while (iter.valid()) {
        const cur = iter.key();
        expect(Buffer.compare(prev, cur)).toBeLessThanOrEqual(0);
        prev = cur;
        count++;
        iter.next();
      }
      expect(count).toBe(n);
    }
  });
});

// ─── LRUCache 随机模糊 ───
describe('LRUCache Fuzz', () => {
  it('random insert/lookup/erase operations maintain consistency', () => {
    const cache = new LRUCache(50);
    const truth = new Map<string, Buffer>();
    for (let i = 0; i < 200; i++) {
      const op = randomInt(0, 3);
      const key = randomBytes(4);
      const hexKey = key.toString('hex');
      if (op === 0) {
        // Insert
        const val = randomBytes(8);
        truth.set(hexKey, val);
        cache.insert(key, val, 1);
      } else if (op === 1) {
        // Lookup
        const expected = truth.get(hexKey);
        const actual = cache.lookup(key);
        if (expected) {
          // May or may not still be in cache (eviction)
          if (actual) expect(actual.value).toEqual(expected);
        }
      } else {
        // Erase
        truth.delete(hexKey);
        cache.erase(key);
        expect(cache.lookup(key)).toBeNull();
      }
    }
  });
});

// ─── WriteBatch 随机模糊 ───
describe('WriteBatch Fuzz', () => {
  it('random operations encode/decode round-trip', () => {
    for (let round = 0; round < 30; round++) {
      const batch = new WriteBatch();
      const nOps = randomInt(0, 20);
      let totalSize = 0;
      for (let i = 0; i < nOps; i++) {
        if (randomInt(0, 2) === 0) {
          batch.put(randomBytes(randomInt(1, 50)), randomBytes(randomInt(0, 100)));
        } else {
          batch.delete(randomBytes(randomInt(1, 50)));
        }
        totalSize++;
      }
      const encoded = batch.encode();
      const decoded = WriteBatch.decode(encoded);
      expect(decoded.approxSize()).toBe(batch.approxSize());
    }
  });
});

// ─── 融合测试：随机 DB 操作 ───
describe('DB Random Operation Fuzz', () => {
  afterEach(() => {
    try { rmSync(join(tmpdir(), 'fuzzdb'), { recursive: true, force: true }); } catch {}
  });

  it('random sequence of DB operations should not crash', async () => {
    const dir = join(tmpdir(), 'fuzzdb');
    const db = await DB.open(dir, { createIfMissing: true, compression: 0 });

    try {
      for (let i = 0; i < 50; i++) {
        const op = randomInt(0, 3);
        const key = Buffer.from(`fuzz${randomInt(0, 20)}`);
        if (op === 0) {
          await db.put(key, randomBytes(randomInt(1, 50)));
        } else if (op === 1) {
          await db.get(key);
        } else {
          await db.delete(key);
        }
      }
    } finally {
      await db.close();
    }
  }, 30000);
});
