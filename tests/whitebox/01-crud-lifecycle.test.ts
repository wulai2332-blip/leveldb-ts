/**
 * Whitebox Test 01: Core CRUD & Database Lifecycle
 *
 * Covers:
 *   - DB.open / DB.destroyDB / db.close
 *   - DBOptions: createIfMissing, errorIfExists
 *   - db.get / db.put / db.delete
 *   - Encoding: utf8 | buffer
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DB } from '../../src/index.js';

const TEST_DIR = join(import.meta.dirname ?? __dirname, '..', '..', '.test-tmp', '01-crud');

describe('01 - Core CRUD & Database Lifecycle', () => {
  beforeAll(() => {
    // Ensure clean state
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    // Cleanup
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  // ── DB.open: createIfMissing ──────────────────────────────

  describe('DB.open — createIfMissing', () => {
    it('should throw when opening non-existent DB without createIfMissing', async () => {
      const dbPath = join(TEST_DIR, 'nonexistent-db');
      await expect(DB.open(dbPath, { createIfMissing: false })).rejects.toThrow();
    });

    it('should create DB directory when createIfMissing=true', async () => {
      const dbPath = join(TEST_DIR, 'auto-create-db');
      const db = await DB.open(dbPath, { createIfMissing: true });
      expect(existsSync(dbPath)).toBe(true);
      await db.close();
    });

    it('should default createIfMissing to false (throws on non-existing)', async () => {
      const dbPath = join(TEST_DIR, 'default-no-create');
      await expect(DB.open(dbPath)).rejects.toThrow();
    });
  });

  // ── DB.open: errorIfExists ────────────────────────────────

  describe('DB.open — errorIfExists', () => {
    it('should throw when DB already exists and errorIfExists=true', async () => {
      const dbPath = join(TEST_DIR, 'error-if-exists');
      const db = await DB.open(dbPath, { createIfMissing: true });
      await db.close();

      await expect(
        DB.open(dbPath, { errorIfExists: true })
      ).rejects.toThrow();
    });

    it('should NOT throw when DB already exists and errorIfExists=false (default)', async () => {
      const dbPath = join(TEST_DIR, 'no-error-reopen');
      const db1 = await DB.open(dbPath, { createIfMissing: true });
      await db1.close();

      // Reopen without errorIfExists — should succeed
      const db2 = await DB.open(dbPath, { createIfMissing: true });
      expect(db2).toBeDefined();
      await db2.close();
    });
  });

  // ── Basic CRUD: put → get ────────────────────────────────

  describe('Basic put → get', () => {
    it('should write and read back a string value (utf8 encoding)', async () => {
      const dbPath = join(TEST_DIR, 'put-get-utf8');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      await db.put('hello', 'world');
      const result = await db.get('hello');
      expect(result).toBe('world');

      await db.close();
    });

    it('should write and read back a Buffer value (buffer encoding)', async () => {
      const dbPath = join(TEST_DIR, 'put-get-buffer');
      const db = await DB.open(dbPath, { createIfMissing: true });

      const keyBuf = Buffer.from('binary-key');
      const valBuf = Buffer.from([0x01, 0x02, 0x03, 0xff]);
      await db.put(keyBuf, valBuf);
      const result = await db.get(keyBuf);
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result).toEqual(valBuf);

      await db.close();
    });

    it('should overwrite existing key with new value', async () => {
      const dbPath = join(TEST_DIR, 'put-overwrite');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      await db.put('name', 'alice');
      await db.put('name', 'bob');
      const result = await db.get('name');
      expect(result).toBe('bob');

      await db.close();
    });

    it('should return null for non-existent key', async () => {
      const dbPath = join(TEST_DIR, 'get-missing');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      const result = await db.get('no-such-key');
      expect(result).toBeNull();

      await db.close();
    });
  });

  // ── Delete + get ──────────────────────────────────────────

  describe('Delete → get', () => {
    it('should return null after deleting a key', async () => {
      const dbPath = join(TEST_DIR, 'delete-get');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      await db.put('temp', 'data');
      expect(await db.get('temp')).toBe('data');

      await db.delete('temp');
      expect(await db.get('temp')).toBeNull();

      await db.close();
    });

    it('should not throw when deleting a non-existent key', async () => {
      const dbPath = join(TEST_DIR, 'delete-missing');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      // Should resolve without throwing
      await expect(db.delete('no-such-key')).resolves.toBeUndefined();

      await db.close();
    });
  });

  // ── DB.destroyDB ──────────────────────────────────────────

  describe('DB.destroyDB', () => {
    it('should delete the database directory', async () => {
      const dbPath = join(TEST_DIR, 'to-destroy');
      const db = await DB.open(dbPath, { createIfMissing: true });
      await db.put('x', '1');
      await db.close();

      expect(existsSync(dbPath)).toBe(true);
      await DB.destroyDB(dbPath);
      // After destroy, the directory should no longer exist
      expect(existsSync(dbPath)).toBe(false);
    });

    it('should be a no-op for non-existent path', async () => {
      await expect(
        DB.destroyDB(join(TEST_DIR, 'phantom-db'))
      ).resolves.toBeUndefined();
    });
  });

  // ── Key/Value Encoding ────────────────────────────────────

  describe('Encoding: utf8 vs buffer', () => {
    it('should encode/decode keys as utf8 strings', async () => {
      const dbPath = join(TEST_DIR, 'encoding-utf8');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      await db.put('中文键', '中文值');
      const result = await db.get('中文键');
      expect(result).toBe('中文值');

      await db.close();
    });

    it('should encode/decode values as binary when using buffer encoding', async () => {
      const dbPath = join(TEST_DIR, 'encoding-mixed');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'buffer',
      });

      const buf = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      await db.put('bin-key', buf);
      const result = await db.get('bin-key');
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result).toEqual(buf);

      await db.close();
    });

    it('should accept string key even when keyEncoding is buffer', async () => {
      const dbPath = join(TEST_DIR, 'encoding-buffer-key-str');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'buffer',
        valueEncoding: 'buffer',
      });

      // Passing a string when keyEncoding is 'buffer' should work
      // (it gets raw bytes from string without utf8 interpretation)
      await db.put('string-key', Buffer.from([0x42]));
      const result = await db.get('string-key');
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result).toEqual(Buffer.from([0x42]));

      await db.close();
    });

    it('should default encoding to buffer', async () => {
      const dbPath = join(TEST_DIR, 'encoding-default');
      const db = await DB.open(dbPath, { createIfMissing: true });

      const k = Buffer.from('dk');
      const v = Buffer.from('dv');
      await db.put(k, v);
      const result = await db.get(k);
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result).toEqual(v);

      await db.close();
    });
  });

  // ── Close semantics ───────────────────────────────────────

  describe('db.close()', () => {
    it('should be idempotent (calling close twice should not throw)', async () => {
      const dbPath = join(TEST_DIR, 'close-twice');
      const db = await DB.open(dbPath, { createIfMissing: true });
      await db.close();
      // Second close should not throw
      await expect(db.close()).resolves.toBeUndefined();
    });
  });
});
