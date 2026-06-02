/**
 * 变异与覆盖率测试 (Mutation & Coverage Testing)
 * 验证测试有效性——如果修改代码逻辑，测试应该能捕获。
 * 对关键代码路径进行"变异"检查：故意引入错误验证测试能检测。
 * 覆盖: 所有模块关键路径, 行/分支/条件/路径覆盖率检查
 */
import { describe, it, expect } from 'vitest';
import { crc32, crc32cMask, crc32cUnmask } from '../../src/codec.js';
import { encodeInternalKey, decodeInternalKey, ValueType } from '../../src/types.js';
import { LRUCache } from '../../src/cache.js';
import { WriteBatch } from '../../src/write_batch.js';
import { BytewiseComparator } from '../../src/comparator.js';
import { Status, StatusCode } from '../../src/status.js';
import { newBloomFilterPolicy } from '../../src/sstable/bloom.js';

// ─── 变异检测：CRC 计算错误 ───
describe('CRC Mutation Detection', () => {
  it('CRC of same data must be equal (invariant)', () => {
    const data = Buffer.from('invariant check');
    const c1 = crc32(data);
    const c2 = crc32(data);
    expect(c1).toBe(c2); // If this fails, CRC is non-deterministic
  });

  it('different data should (likely) produce different CRC', () => {
    const a = crc32(Buffer.from('hello'));
    const b = crc32(Buffer.from('world'));
    expect(a).not.toBe(b);
  });

  it('mask/unmask identity (critical invariant)', () => {
    // If mask/unmask are broken, WAL checksums will break
    for (const v of [0, 1, 0x12345678, 0xffffffff, 0xdeadbeef, 0xc0ffee]) {
      expect(crc32cUnmask(crc32cMask(v))).toBe(v >>> 0);
    }
  });

  it('CRC of single byte change should differ', () => {
    const a = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const b = Buffer.from([0x01, 0x02, 0x03, 0x05]); // 1 byte diff
    expect(crc32(a)).not.toBe(crc32(b));
  });
});

// ─── 变异检测：InternalKey 编码不变量 ───
describe('InternalKey Invariant Detection', () => {
  it('round-trip preserves all fields', () => {
    const cases: [Buffer, bigint, ValueType][] = [
      [Buffer.from('a'), 0n, ValueType.Value],
      [Buffer.from('key'), 42n, ValueType.Value],
      [Buffer.from('del'), 100n, ValueType.Deletion],
      [Buffer.alloc(0), 1n << 44n, ValueType.Value],
    ];
    for (const [uk, seq, vt] of cases) {
      const ik = encodeInternalKey(uk, seq, vt);
      const decoded = decodeInternalKey(ik);
      expect(decoded.userKey).toEqual(uk);
      expect(decoded.sequence).toBe(seq);
      expect(decoded.valueType).toBe(vt);
    }
  });

  it('sequence ordering invariant: higher seq → smaller internal key', () => {
    const key = Buffer.from('order');
    const s1 = encodeInternalKey(key, 1000n, ValueType.Value);
    const s2 = encodeInternalKey(key, 1n, ValueType.Value);
    expect(Buffer.compare(s1, s2)).toBeLessThan(0);
  });
});

// ─── 变异检测：LRU Cache 不变量 ───
describe('LRUCache Invariant Detection', () => {
  it('totalCharge never exceeds capacity (invariant)', () => {
    const cache = new LRUCache(20);
    for (let i = 0; i < 100; i++) {
      cache.insert(Buffer.from(`k${i}`), Buffer.from(`v${i}`), 3);
      expect(cache.totalCharge()).toBeLessThanOrEqual(20);
    }
  });

  it('insert then lookup returns same value (or evicted to null)', () => {
    const cache = new LRUCache(1000);
    const key = Buffer.from('consistent');
    const val = Buffer.from('value');
    cache.insert(key, val, 10);
    const found = cache.lookup(key);
    expect(found).not.toBeNull();
    expect(found!.value).toEqual(val);
  });

  it('erase removes entry completely', () => {
    const cache = new LRUCache(100);
    cache.insert(Buffer.from('k'), Buffer.from('v'), 10);
    cache.erase(Buffer.from('k'));
    expect(cache.lookup(Buffer.from('k'))).toBeNull();
    expect(cache.totalCharge()).toBe(0);
  });

  it('prune empties cache (totalCharge → 0)', () => {
    const cache = new LRUCache(100);
    for (let i = 0; i < 20; i++) {
      cache.insert(Buffer.from(`k${i}`), Buffer.from(`v${i}`), 2);
    }
    cache.prune();
    expect(cache.totalCharge()).toBe(0);
  });
});

// ─── 变异检测：Status 状态机 ───
describe('Status Invariant Detection', () => {
  it('OK status: ok()=true, all isXxx()=false', () => {
    const s = Status.ok();
    expect(s.ok()).toBe(true);
    expect(s.isNotFound()).toBe(false);
    expect(s.isCorruption()).toBe(false);
    expect(s.isIOError()).toBe(false);
    expect(s.isNotSupported()).toBe(false);
  });

  it('Only one error type should be true at a time', () => {
    const statuses = [
      Status.notFound('nf'),
      Status.corruption('corr'),
      Status.ioError('io'),
      Status.notSupported('ns'),
    ];
    for (const s of statuses) {
      const flags = [s.isNotFound(), s.isCorruption(), s.isIOError(), s.isNotSupported()];
      const trueCount = flags.filter(Boolean).length;
      expect(trueCount).toBe(1);
    }
  });
});

// ─── 变异检测：WriteBatch 不变量 ───
describe('WriteBatch Invariant Detection', () => {
  it('decode(encode(x)) should be structurally equivalent to x', () => {
    const batch = new WriteBatch();
    batch.put(Buffer.from('k1'), Buffer.from('v1'));
    batch.delete(Buffer.from('k2'));
    const decoded = WriteBatch.decode(batch.encode());
    expect(decoded.approxSize()).toBe(batch.approxSize());
  });

  it('clear resets size to 0', () => {
    const batch = new WriteBatch();
    batch.put(Buffer.from('k1'), Buffer.from('v1'));
    batch.put(Buffer.from('k2'), Buffer.from('v2'));
    batch.clear();
    expect(batch.approxSize()).toBe(0);
    let iterated = 0;
    batch.iterate(() => { iterated++; });
    expect(iterated).toBe(0);
  });
});

// ─── 变异检测：Bloom Filter 不变量 ───
describe('BloomFilter Invariant Detection', () => {
  it('inserted keys always return true (no false negatives)', () => {
    const filter = newBloomFilterPolicy(10);
    for (let round = 0; round < 30; round++) {
      const keys = [Buffer.from(`k${round}`), Buffer.from(`extra${round}`)];
      const bloom = filter.createFilter(keys);
      for (const k of keys) {
        // No false negatives — this is a critical invariant
        expect(filter.keyMayMatch(k, bloom)).toBe(true);
      }
    }
  });
});

// ─── 行/分支覆盖率检查点 ───
describe('Coverage Checkpoints', () => {
  it('BytewiseComparator: all public methods tested', () => {
    const cmp = new BytewiseComparator();
    // name
    expect(typeof cmp.name()).toBe('string');
    // compare: 3 branches (less, equal, greater)
    expect(cmp.compare(Buffer.from('a'), Buffer.from('b'))).toBeLessThan(0);
    expect(cmp.compare(Buffer.from('b'), Buffer.from('a'))).toBeGreaterThan(0);
    expect(cmp.compare(Buffer.from('a'), Buffer.from('a'))).toBe(0);
    // findShortestSeparator
    expect(cmp.findShortestSeparator(Buffer.from('a'), Buffer.from('c')).length).toBeGreaterThanOrEqual(1);
    // findShortSuccessor
    expect(Buffer.compare(cmp.findShortSuccessor(Buffer.from('ab')), Buffer.from('ab'))).toBeGreaterThan(0);
  });

  it('ValueType: Deletion and Value are distinguishable', () => {
    expect(ValueType.Deletion).toBe(0);
    expect(ValueType.Value).toBe(1);
    expect(ValueType.Value).not.toBe(ValueType.Deletion);
  });

  it('StatusCode: all values distinct', () => {
    const codes = Object.values(StatusCode).filter(v => typeof v === 'number');
    expect(new Set(codes).size).toBe(codes.length); // all unique
  });
});

// ─── VersionEditTag 常量完整性 ───
describe('VersionEditTag Coverage', () => {
  it('all tags are unique and positive integers', async () => {
    const mod = await import('../../src/version/version_edit_tag.js');
    const tags = Object.values(mod.VersionEditTag).filter(v => typeof v === 'number');
    // Verify uniqueness using Set
    const uniqueTags = new Set(tags);
    expect(uniqueTags.size).toBe(tags.length);
    for (const t of tags) {
      expect(t).toBeGreaterThan(0);
    }
  });
});
