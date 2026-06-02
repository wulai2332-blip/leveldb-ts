/**
 * 黑盒测试 (Black-box Testing)
 * 基于模块输入输出规范进行测试，不关心内部实现。
 * 覆盖模块: options, logger, env, snapshot, write_batch, filename, repair, index exports
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  defaultDBOptions, defaultReadOptions, defaultWriteOptions,
  CompressionType,
} from '../../src/options.js';
import { ConsoleLogger, NoopLogger } from '../../src/logger.js';
import { NodeEnv } from '../../src/env.js';
import { Snapshot } from '../../src/snapshot.js';
import { WriteBatch } from '../../src/write_batch.js';
import { tableFileName, logFileName } from '../../src/sstable/filename.js';
import { repairDB } from '../../src/repair.js';
import { DB, Status, BytewiseComparator, LRUCache, newBloomFilterPolicy, CompressionType as CT } from '../../src/index.js';

const testDir = join(tmpdir(), `leveldb-blackbox-${randomBytes(4).toString('hex')}`);

afterEach(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

// ─── Options 默认值验证 ───
describe('Options Black-box', () => {
  it('defaultDBOptions should return all required fields with sane defaults', () => {
    const opts = defaultDBOptions();
    expect(opts.createIfMissing).toBe(false);
    expect(opts.errorIfExists).toBe(false);
    expect(opts.writeBufferSize).toBe(4 * 1024 * 1024);
    expect(opts.maxOpenFiles).toBe(1000);
    expect(opts.blockSize).toBe(4096);
    expect(opts.blockRestartInterval).toBe(16);
    expect(opts.maxFileSize).toBe(2 * 1024 * 1024);
    expect(opts.compression).toBe(CompressionType.Snappy);
    expect(opts.keyEncoding).toBe('buffer');
    expect(opts.valueEncoding).toBe('buffer');
  });

  it('defaultReadOptions should have sane defaults', () => {
    const opts = defaultReadOptions();
    expect(opts.verifyChecksums).toBe(false);
    expect(opts.fillCache).toBe(true);
  });

  it('defaultWriteOptions should have sync=false', () => {
    const opts = defaultWriteOptions();
    expect(opts.sync).toBe(false);
  });
});

// ─── Logger 接口行为 ───
describe('Logger Black-box', () => {
  it('ConsoleLogger should output without throwing', () => {
    const logger = new ConsoleLogger();
    expect(() => logger.info('test')).not.toThrow();
    expect(() => logger.warn('test')).not.toThrow();
    expect(() => logger.error('test')).not.toThrow();
  });

  it('NoopLogger should not throw but produce no output', () => {
    const logger = new NoopLogger();
    expect(() => logger.info('test')).not.toThrow();
    expect(() => logger.warn('test')).not.toThrow();
    expect(() => logger.error('test')).not.toThrow();
  });
});

// ─── Env 接口行为 ───
describe('NodeEnv Black-box', () => {
  const envDir = join(testDir, 'env-test');
  let env: NodeEnv;

  beforeEach(() => {
    mkdirSync(envDir, { recursive: true });
    env = new NodeEnv();
  });

  it('should create and detect directories', async () => {
    const dir = join(envDir, 'newdir');
    await env.createDir(dir);
    expect(existsSync(dir)).toBe(true);
  });

  it('should write and read files', async () => {
    const fp = join(envDir, 'test.bin');
    const data = Buffer.from('hello world');
    await env.writeFile(fp, data);
    expect(await env.fileExists(fp)).toBe(true);
    const read = await env.readFile(fp);
    expect(read).toEqual(data);
  });

  it('should get file size', async () => {
    const fp = join(envDir, 'size.bin');
    await env.writeFile(fp, Buffer.from('12345'));
    const size = await env.getFileSize(fp);
    expect(size).toBe(5);
  });

  it('should rename files', async () => {
    const oldPath = join(envDir, 'old.txt');
    const newPath = join(envDir, 'new.txt');
    await env.writeFile(oldPath, Buffer.from('data'));
    await env.renameFile(oldPath, newPath);
    expect(await env.fileExists(newPath)).toBe(true);
    expect(await env.fileExists(oldPath)).toBe(false);
  });

  it('should remove files', async () => {
    const fp = join(envDir, 'todel.bin');
    await env.writeFile(fp, Buffer.from('data'));
    await env.removeFile(fp);
    expect(await env.fileExists(fp)).toBe(false);
  });

  it('should list children', async () => {
    await env.writeFile(join(envDir, 'a.txt'), Buffer.alloc(0));
    await env.writeFile(join(envDir, 'b.txt'), Buffer.alloc(0));
    const children = await env.getChildren(envDir);
    expect(children).toContain('a.txt');
    expect(children).toContain('b.txt');
  });

  it('should create and remove lock files', async () => {
    const lockPath = join(envDir, 'LOCK');
    await env.lockFile(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    await env.unlockFile(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('should remove dirs recursively', async () => {
    const dir = join(envDir, 'subdir');
    await env.createDir(dir);
    await env.writeFile(join(dir, 'f.txt'), Buffer.from('x'));
    await env.removeDir(dir);
    expect(existsSync(dir)).toBe(false);
  });
});

// ─── Snapshot 接口行为 ───
describe('Snapshot Black-box', () => {
  it('should hold correct sequence number', () => {
    const snap = new Snapshot(42n);
    expect(snap.sequence).toBe(42n);
  });

  it('should call onRelease via Symbol.dispose', () => {
    let released = false;
    const snap = new Snapshot(1n, () => { released = true; });
    snap[Symbol.dispose]();
    expect(released).toBe(true);
  });

  it('should not call onRelease twice', () => {
    let count = 0;
    const snap = new Snapshot(1n, () => { count++; });
    snap[Symbol.dispose]();
    snap[Symbol.dispose]();
    expect(count).toBe(1);
  });
});

// ─── WriteBatch 接口行为 ───
describe('WriteBatch Black-box', () => {
  it('should track approximate size', () => {
    const batch = new WriteBatch();
    batch.put(Buffer.from('key'), Buffer.from('value'));
    expect(batch.approxSize()).toBeGreaterThan(0);
  });

  it('should clear entries and reset size', () => {
    const batch = new WriteBatch();
    batch.put(Buffer.from('k'), Buffer.from('v'));
    batch.clear();
    expect(batch.approxSize()).toBe(0);
  });

  it('should iterate over entries', () => {
    const batch = new WriteBatch();
    batch.put(Buffer.from('k1'), Buffer.from('v1'));
    batch.delete(Buffer.from('k2'));
    const entries: string[] = [];
    batch.iterate((key) => { entries.push(key.toString()); });
    expect(entries).toHaveLength(2);
  });

  it('should encode/decode round-trip', () => {
    const batch = new WriteBatch();
    batch.put(Buffer.from('hello'), Buffer.from('world'));
    batch.delete(Buffer.from('bye'));
    const encoded = batch.encode();
    const decoded = WriteBatch.decode(encoded);
    expect(decoded.approxSize()).toBe(batch.approxSize());
  });

  it('should append another batch', () => {
    const a = new WriteBatch();
    a.put(Buffer.from('a'), Buffer.from('1'));
    const b = new WriteBatch();
    b.put(Buffer.from('b'), Buffer.from('2'));
    a.append(b);
    expect(a.approxSize()).toBeGreaterThan(0);
  });
});

// ─── Filename 命名规则 ───
describe('Filename Black-box', () => {
  it('tableFileName should produce correct format', () => {
    expect(tableFileName('/db', 42)).toBe(join('/db', '000042.ldb'));
  });

  it('logFileName should produce correct format', () => {
    expect(logFileName('/db', 7)).toBe(join('/db', '000007.log'));
  });

  it('should zero-pad to 6 digits', () => {
    expect(tableFileName('/x', 0)).toBe(join('/x', '000000.ldb'));
    expect(tableFileName('/x', 999999)).toBe(join('/x', '999999.ldb'));
  });
});

// ─── Status 接口行为 ───
describe('Status Black-box', () => {
  it('should create all error types with messages', () => {
    expect(Status.ok().ok()).toBe(true);
    expect(Status.notFound('key missing').isNotFound()).toBe(true);
    expect(Status.corruption('bad data').isCorruption()).toBe(true);
    expect(Status.ioError('disk full').isIOError()).toBe(true);
    expect(Status.notSupported('nope').isNotSupported()).toBe(true);
  });
});

// ─── Index 公共 API 导出验证 ───
describe('Public API Exports Black-box', () => {
  it('should export DB class', () => {
    expect(typeof DB.open).toBe('function');
  });

  it('should export Status class', () => {
    expect(typeof Status.ok).toBe('function');
  });

  it('should export WriteBatch', () => {
    expect(typeof WriteBatch).toBe('function');
    const wb = new WriteBatch();
    expect(typeof wb.put).toBe('function');
  });

  it('should export Snapshot', () => {
    expect(typeof Snapshot).toBe('function');
  });

  it('should export Comparator classes', () => {
    const cmp = new BytewiseComparator();
    expect(typeof cmp.compare).toBe('function');
  });

  it('should export LRUCache', () => {
    const cache = new LRUCache(100);
    expect(typeof cache.insert).toBe('function');
  });

  it('should export Bloom filter factory', () => {
    const filter = newBloomFilterPolicy(10);
    expect(typeof filter.createFilter).toBe('function');
  });

  it('should export loggers', () => {
    expect(typeof ConsoleLogger).toBe('function');
    expect(typeof NoopLogger).toBe('function');
  });

  it('should export NodeEnv', () => {
    expect(typeof NodeEnv).toBe('function');
  });

  it('should export CompressionType enum', () => {
    expect(CT.None).toBe(0);
    expect(CT.Snappy).toBe(1);
    expect(CT.Zstd).toBe(2);
  });
});
