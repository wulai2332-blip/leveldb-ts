/**
 * Whitebox Test 07: Infrastructure & Edge Cases
 *
 * Targets remaining low-coverage modules:
 *   - logger.ts    (0%  → target 100%)
 *   - env.ts       (0%  → target 60%+)
 *   - repair.ts    (0%  → target 80%+)
 *   - table_cache.ts (73% → target 85%+)
 *   - iterator.ts reverse edge cases
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
import { ConsoleLogger, NoopLogger } from '../../src/logger.js';
import type { Logger } from '../../src/logger.js';
import { NodeEnv } from '../../src/env.js';
import { repairDB } from '../../src/repair.js';
import { DB } from '../../src/db.js';
import { TableCache } from '../../src/table_cache.js';
import { BytewiseComparator } from '../../src/comparator.js';

const TEST_DIR = join(import.meta.dirname ?? __dirname, '..', '..', '.test-tmp', '07-infra');

// ─────────────────────────────────────────────────────────────
// logger.ts
// ─────────────────────────────────────────────────────────────

describe('07a - Logger', () => {
  it('ConsoleLogger.log() should not throw', () => {
    const logger = new ConsoleLogger();
    expect(() => logger.info('test message')).not.toThrow();
    expect(() => logger.warn('warning', 'extra')).not.toThrow();
    expect(() => logger.error('error!')).not.toThrow();
  });

  it('NoopLogger should not throw (and do nothing)', () => {
    const logger = new NoopLogger();
    expect(() => logger.info('ignored')).not.toThrow();
    expect(() => logger.warn('also ignored')).not.toThrow();
    expect(() => logger.error('still ignored')).not.toThrow();
  });

  it('Logger interface contract', () => {
    const logger: Logger = new ConsoleLogger();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });
});

// ─────────────────────────────────────────────────────────────
// env.ts
// ─────────────────────────────────────────────────────────────

describe('07b - NodeEnv', () => {
  const envDir = join(TEST_DIR, 'env-test');

  beforeAll(async () => {
    if (existsSync(envDir)) rmSync(envDir, { recursive: true, force: true });
    mkdirSync(envDir, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(envDir)) rmSync(envDir, { recursive: true, force: true });
  });

  it('createDir should create directory', async () => {
    const env = new NodeEnv();
    const dir = join(envDir, 'new-dir');
    await env.createDir(dir);
    expect(existsSync(dir)).toBe(true);
  });

  it('createDir should be idempotent', async () => {
    const env = new NodeEnv();
    const dir = join(envDir, 'idempotent-dir');
    await env.createDir(dir);
    await env.createDir(dir); // Second call should not throw
    expect(existsSync(dir)).toBe(true);
  });

  it('writeFile + readFile round trip', async () => {
    const env = new NodeEnv();
    const file = join(envDir, 'rw-test.bin');
    const data = Buffer.from([0x01, 0x02, 0x03, 0xff]);
    await env.writeFile(file, data);
    const read = await env.readFile(file);
    expect(read).toEqual(data);
  });

  it('fileExists should detect files', async () => {
    const env = new NodeEnv();
    const file = join(envDir, 'exists-test.txt');
    await writeFile(file, 'hello');
    expect(await env.fileExists(file)).toBe(true);
    expect(await env.fileExists(join(envDir, 'phantom'))).toBe(false);
  });

  it('getFileSize should return file size', async () => {
    const env = new NodeEnv();
    const file = join(envDir, 'size-test.bin');
    const data = Buffer.alloc(123, 0x42);
    await env.writeFile(file, data);
    const size = await env.getFileSize(file);
    expect(size).toBe(123);
  });

  it('removeFile should delete file', async () => {
    const env = new NodeEnv();
    const file = join(envDir, 'remove-me.tmp');
    await env.writeFile(file, Buffer.from('temp'));
    expect(await env.fileExists(file)).toBe(true);
    await env.removeFile(file);
    expect(await env.fileExists(file)).toBe(false);
  });

  it('renameFile should move file', async () => {
    const env = new NodeEnv();
    const src = join(envDir, 'rename-src.txt');
    const dst = join(envDir, 'rename-dst.txt');
    await env.writeFile(src, Buffer.from('data'));
    await env.renameFile(src, dst);
    expect(await env.fileExists(src)).toBe(false);
    expect(await env.fileExists(dst)).toBe(true);
  });

  it('getChildren should list directory contents', async () => {
    const env = new NodeEnv();
    const dir = join(envDir, 'children-test');
    await env.createDir(dir);
    await env.writeFile(join(dir, 'a.txt'), Buffer.from('a'));
    await env.writeFile(join(dir, 'b.txt'), Buffer.from('b'));

    const children = await env.getChildren(dir);
    expect(children).toContain('a.txt');
    expect(children).toContain('b.txt');
  });

  it('removeDir should delete directory recursively', async () => {
    const env = new NodeEnv();
    const dir = join(envDir, 'remove-dir');
    await env.createDir(dir);
    await env.writeFile(join(dir, 'sub.txt'), Buffer.from('x'));
    await env.removeDir(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('lockFile + unlockFile should work', async () => {
    const env = new NodeEnv();
    const lock = join(envDir, 'test.lock');
    // Should not throw
    await env.lockFile(lock);
    expect(existsSync(lock)).toBe(true);
    await env.unlockFile(lock);
    expect(existsSync(lock)).toBe(false);
  });

  it('lockFile should throw on directory', async () => {
    const env = new NodeEnv();
    const dir = join(envDir, 'cant-lock-dir');
    await env.createDir(dir);
    await expect(env.lockFile(dir)).rejects.toThrow('directory');
  });

  it('unlockFile should be no-op for missing file', async () => {
    const env = new NodeEnv();
    await expect(env.unlockFile(join(envDir, 'no-lock'))).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// repair.ts
// ─────────────────────────────────────────────────────────────

describe('07c - repairDB', () => {
  beforeAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('should throw for non-existent database', async () => {
    await expect(
      repairDB(join(TEST_DIR, 'no-such-db'))
    ).rejects.toThrow('does not exist');
  });

  it('should repair a valid database without error', async () => {
    const dbPath = join(TEST_DIR, 'repair-test');
    // Create a valid DB first with enough data to trigger flush
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
      writeBufferSize: 512,
    });
    // Write enough to force flush → ensure SSTable persistence
    for (let i = 0; i < 50; i++) {
      await db.put(`r-${i}`, `rv-${i}`);
    }
    await db.close();

    // Repair should succeed (no throw)
    await expect(repairDB(dbPath, {
      createIfMissing: true,
    })).resolves.toBeUndefined();

    // After repair, DB should be openable
    const db2 = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
    });
    expect(db2).toBeDefined();
    await db2.close();
  });

  it('should handle DB with stale LOCK file', async () => {
    const dbPath = join(TEST_DIR, 'repair-lock');
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
    });
    await db.put('k', 'v');
    await db.close();

    // Create a stale LOCK file
    writeFileSync(join(dbPath, 'LOCK'), 'stale');

    await expect(repairDB(dbPath)).resolves.toBeUndefined();
    expect(existsSync(join(dbPath, 'LOCK'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// table_cache.ts (direct tests)
// ─────────────────────────────────────────────────────────────

describe('07d - TableCache', () => {
  it('should create cache with specified capacity', () => {
    const tc = new TableCache(100);
    expect(tc).toBeDefined();
  });

  it('should evict entry by file number', () => {
    const tc = new TableCache(100);
    // Evict non-existent entry should not throw
    expect(() => tc.evict(42)).not.toThrow();
  });

  it('should cache table across lookups (using DB)', async () => {
    const dbPath = join(TEST_DIR, 'tc-db');
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
      writeBufferSize: 512,
    });

    // Write data to create SST files
    for (let i = 0; i < 100; i++) {
      await db.put(`tc-${i}`, `val-${i}`);
    }

    // Close and reopen to trigger table cache usage
    await db.close();
    const db2 = await DB.open(dbPath, {
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
    });

    // Multiple reads should use table cache
    for (let i = 0; i < 50; i++) {
      expect(await db2.get(`tc-${i}`)).toBe(`val-${i}`);
    }

    await db2.close();
  }, 30000);
});

// ─────────────────────────────────────────────────────────────
// iterator.ts: reverse iteration edge cases
// ─────────────────────────────────────────────────────────────

describe('07e - Iterator reverse edge cases', () => {
  beforeAll(() => {
    if (existsSync(TEST_DIR)) {
      // Don't remove, just ensure exists
      mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  it('should handle seek + prev combination', async () => {
    const dbPath = join(TEST_DIR, 'iter-seek-prev');
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
    });

    await db.put('a', '1');
    await db.put('c', '3');
    await db.put('e', '5');

    // Seek to 'd' → lands on 'e', then prev → 'c' → 'a'
    const iter = db.iterator();
    await iter.seek(Buffer.from('d'));
    expect(iter.valid()).toBe(true);
    expect(iter.key().toString()).toBe('e');

    await iter.prev();
    expect(iter.valid()).toBe(true);
    expect(iter.key().toString()).toBe('c');

    await iter.prev();
    expect(iter.valid()).toBe(true);
    expect(iter.key().toString()).toBe('a');

    await iter.prev();
    expect(iter.valid()).toBe(false);

    iter.close();
    await db.close();
  });

  it('should handle seekToLast on single entry', async () => {
    const dbPath = join(TEST_DIR, 'iter-last-single');
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
    });

    await db.put('only', 'one');
    const iter = db.iterator();
    await iter.seekToLast();
    expect(iter.valid()).toBe(true);
    expect(iter.key().toString()).toBe('only');

    iter.close();
    await db.close();
  });

  it('should handle seek after seekToLast', async () => {
    const dbPath = join(TEST_DIR, 'iter-last-then-seek');
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
    });

    await db.put('m', 'mid');
    await db.put('z', 'end');

    const iter = db.iterator();
    await iter.seekToLast();
    expect(iter.key().toString()).toBe('z');

    // Reverse iterate
    await iter.prev();
    expect(iter.key().toString()).toBe('m');

    // Now seek forward to 'm'
    await iter.seek(Buffer.from('m'));
    expect(iter.valid()).toBe(true);
    expect(iter.key().toString()).toBe('m');

    iter.close();
    await db.close();
  });

  it('should handle seekToLast on empty db', async () => {
    const dbPath = join(TEST_DIR, 'iter-last-empty');
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
    });

    const iter = db.iterator();
    await iter.seekToLast();
    expect(iter.valid()).toBe(false);

    iter.close();
    await db.close();
  });

  it('should handle prev with multiple keys (no overwrite)', async () => {
    const dbPath = join(TEST_DIR, 'iter-prev-multi');
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
    });

    await db.put('a', 'v1');
    await db.put('b', 'v2');
    await db.put('c', 'v3');

    const iter = db.iterator();
    await iter.seekToLast();
    expect(iter.valid()).toBe(true);
    expect(iter.key().toString()).toBe('c');
    expect(iter.value().toString()).toBe('v3');

    await iter.prev();
    expect(iter.valid()).toBe(true);
    expect(iter.key().toString()).toBe('b');
    expect(iter.value().toString()).toBe('v2');

    await iter.prev();
    expect(iter.valid()).toBe(true);
    expect(iter.key().toString()).toBe('a');
    expect(iter.value().toString()).toBe('v1');

    await iter.prev();
    expect(iter.valid()).toBe(false);

    iter.close();
    await db.close();
  });
});
