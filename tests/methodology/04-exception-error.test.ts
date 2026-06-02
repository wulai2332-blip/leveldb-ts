/**
 * 异常测试 (Exception Testing)
 * 验证错误处理机制、异常抛出与捕获。
 * 覆盖模块: error, status, block_builder, table, table_builder, db_impl, repair, wal
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  LevelDBError, NotFoundError, CorruptionError, IOError, statusToError,
} from '../../src/error.js';
import { Status } from '../../src/status.js';
import { BlockBuilder } from '../../src/sstable/block_builder.js';
import { TableBuilder } from '../../src/sstable/table_builder.js';
import { Table } from '../../src/sstable/table.js';
import { defaultDBOptions } from '../../src/options.js';
import { DB } from '../../src/db.js';

// ─── Error 异常体系 ───
describe('Error Exception Testing', () => {
  it('LevelDBError should have correct name and code', () => {
    const err = new LevelDBError('TEST_ERROR', 'test message');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LevelDBError');
    expect(err.code).toBe('TEST_ERROR');
    expect(err.message).toBe('test message');
  });

  it('NotFoundError should extend LevelDBError', () => {
    const err = new NotFoundError('key not found');
    expect(err).toBeInstanceOf(LevelDBError);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.name).toBe('NotFoundError');
  });

  it('CorruptionError should extend LevelDBError', () => {
    const err = new CorruptionError('checksum mismatch');
    expect(err).toBeInstanceOf(LevelDBError);
    expect(err).toBeInstanceOf(CorruptionError);
    expect(err.code).toBe('CORRUPTION');
  });

  it('IOError should extend LevelDBError', () => {
    const err = new IOError('disk full');
    expect(err).toBeInstanceOf(LevelDBError);
    expect(err).toBeInstanceOf(IOError);
    expect(err.code).toBe('IO_ERROR');
  });

  it('statusToError should throw on non-OK status', () => {
    expect(() => statusToError(Status.ok())).not.toThrow();
    expect(() => statusToError(Status.notFound('missing'))).toThrow(NotFoundError);
    expect(() => statusToError(Status.corruption('bad'))).toThrow(CorruptionError);
    expect(() => statusToError(Status.ioError('io'))).toThrow(IOError);
  });

  it('statusToError should throw LevelDBError for unknown status', () => {
    const unknownStatus = {
      ok: () => false,
      isNotFound: () => false,
      isCorruption: () => false,
      isIOError: () => false,
      toString: () => 'unknown',
    };
    expect(() => statusToError(unknownStatus)).toThrow(LevelDBError);
  });
});

// ─── BlockBuilder 异常 ───
describe('BlockBuilder Exception Testing', () => {
  it('should throw if finish is called twice', () => {
    const bb = new BlockBuilder(16);
    bb.finish();
    expect(() => bb.finish()).toThrow('already finished');
  });

  // Note: add() after finish() is not checked in current BlockBuilder implementation
});

// ─── TableBuilder 异常 ───
describe('TableBuilder Exception Testing', () => {
  it('should throw if add is called after finish', () => {
    const dir = join(tmpdir(), `tb-test-${randomBytes(4).toString('hex')}`);
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, 'test.ldb');
    try {
      const tb = new TableBuilder(fp, { ...defaultDBOptions(), compression: 0 });
      tb.add(Buffer.from('k'), Buffer.from('v'));
      tb.finish();
      expect(() => tb.add(Buffer.from('k2'), Buffer.from('v2'))).toThrow('already finished');
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it('should throw if finish is called twice', () => {
    const dir = join(tmpdir(), `tb-test2-${randomBytes(4).toString('hex')}`);
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, 'test.ldb');
    try {
      const tb = new TableBuilder(fp, { ...defaultDBOptions(), compression: 0 });
      tb.add(Buffer.from('k'), Buffer.from('v'));
      tb.finish();
      expect(() => tb.finish()).toThrow('already finished');
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});

// ─── Table.open 异常 ───
describe('Table.open Exception Testing', () => {
  it('should throw on non-existent file', async () => {
    await expect(Table.open('/nonexistent/path/table.ldb')).rejects.toThrow();
  });

  it('should throw on file too small', async () => {
    const dir = join(tmpdir(), `small-${randomBytes(4).toString('hex')}`);
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, 'small.ldb');
    writeFileSync(fp, Buffer.from('tiny'));
    try {
      await expect(Table.open(fp)).rejects.toThrow('too small');
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it('should throw on invalid magic number', async () => {
    const dir = join(tmpdir(), `magic-${randomBytes(4).toString('hex')}`);
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, 'bad.ldb');
    const data = Buffer.alloc(100);
    data.write('12345678', 40 + data.length - 48, 'binary');
    writeFileSync(fp, data);
    try {
      await expect(Table.open(fp)).rejects.toThrow('magic');
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});

// ─── DB 异常场景 ───
describe('DB Exception Testing', () => {
  it('should throw if opening non-existent DB without createIfMissing', async () => {
    const dir = join(tmpdir(), `db-nonexist-${randomBytes(4).toString('hex')}`);
    await expect(DB.open(dir, { createIfMissing: false })).rejects.toThrow();
  });

  it('should throw on errorIfExists when DB exists', async () => {
    const dir = join(tmpdir(), `db-exists-${randomBytes(4).toString('hex')}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'test.txt'), 'data');
    try {
      await expect(DB.open(dir, { errorIfExists: true })).rejects.toThrow('already exists');
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});

// ─── Status 异常 ───
describe('Status Exception Testing', () => {
  it('should not throw on any Status creation', () => {
    expect(() => Status.ok()).not.toThrow();
    expect(() => Status.notFound('')).not.toThrow();
    expect(() => Status.corruption('')).not.toThrow();
    expect(() => Status.ioError('')).not.toThrow();
    expect(() => Status.notSupported('')).not.toThrow();
  });

  it('toString on non-OK should include message', () => {
    const s = Status.corruption('checksum error: expected 0x1234');
    expect(s.toString()).toContain('checksum error: expected 0x1234');
  });
});
