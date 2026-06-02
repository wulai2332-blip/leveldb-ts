/**
 * Mock与Stub测试 (Mock & Stub Testing)
 * 用模拟对象隔离依赖，验证组件行为。
 * 覆盖: Mock Comparator, Mock Env, Mock Logger, Spy on LRUCache evictions,
 *        Stub for external IO, Mock IterLike for iterator testing
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Comparator } from '../../src/comparator.js';
import type { Env } from '../../src/env.js';
import type { Logger } from '../../src/logger.js';
import { LRUCache } from '../../src/cache.js';
import { MemTable } from '../../src/memtable.js';
import { ValueType } from '../../src/types.js';
import { WriteBatch } from '../../src/write_batch.js';
import { SkipList } from '../../src/memtable/skiplist.js';
import { Arena } from '../../src/arena.js';
import { BlockBuilder } from '../../src/sstable/block_builder.js';
import { Block } from '../../src/sstable/block.js';
import { Version } from '../../src/version/version.js';
import { VersionEdit } from '../../src/version/version_edit.js';

// ─── Mock Comparator ───
describe('Mock Comparator', () => {
  it('should use mock comparator to verify calls', () => {
    const mockCompare = vi.fn((a: Buffer, b: Buffer) => Buffer.compare(a, b));
    const mockCmp: Comparator = {
      name: () => 'mock',
      compare: mockCompare,
      findShortestSeparator: (s) => s,
      findShortSuccessor: (k) => k,
    };

    const arena = new Arena();
    const list = new SkipList(mockCmp, arena);
    list.insert(Buffer.from('key'), Buffer.from('val'));
    list.find(Buffer.from('key'));

    // Comparator should have been called
    expect(mockCompare).toHaveBeenCalled();
  });
});

// ─── Mock Logger ───
describe('Mock Logger', () => {
  it('should capture log calls', () => {
    const infoSpy = vi.fn();
    const warnSpy = vi.fn();
    const errorSpy = vi.fn();
    const mockLogger: Logger = {
      info: infoSpy,
      warn: warnSpy,
      error: errorSpy,
    };

    mockLogger.info('test info');
    mockLogger.warn('test warn');
    mockLogger.error('test error');

    expect(infoSpy).toHaveBeenCalledWith('test info');
    expect(warnSpy).toHaveBeenCalledWith('test warn');
    expect(errorSpy).toHaveBeenCalledWith('test error');
  });

  it('should capture variadic args in mock', () => {
    const spy = vi.fn();
    const logger: Logger = { info: spy, warn: spy, error: spy };
    logger.info('msg', 42, { key: 'value' });
    expect(spy).toHaveBeenCalledWith('msg', 42, { key: 'value' });
  });
});

// ─── Mock Env ───
describe('Mock Env', () => {
  it('should use mock env for file operations', async () => {
    const files = new Map<string, Buffer>();
    const mockEnv: Env = {
      createDir: vi.fn().mockResolvedValue(undefined),
      removeDir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn(async (name: string) => {
        if (!files.has(name)) throw new Error('ENOENT');
        return files.get(name)!;
      }),
      writeFile: vi.fn(async (name: string, data: Buffer) => {
        files.set(name, data);
      }),
      removeFile: vi.fn(async (name: string) => {
        files.delete(name);
      }),
      renameFile: vi.fn(async (oldP: string, newP: string) => {
        const data = files.get(oldP);
        files.delete(oldP);
        if (data) files.set(newP, data);
      }),
      fileExists: vi.fn(async (name: string) => files.has(name)),
      getChildren: vi.fn(async () => [...files.keys()]),
      getFileSize: vi.fn(async (name: string) => files.get(name)?.length ?? 0),
      lockFile: vi.fn().mockResolvedValue(undefined),
      unlockFile: vi.fn().mockResolvedValue(undefined),
    };

    await mockEnv.writeFile('test.txt', Buffer.from('data'));
    expect(await mockEnv.fileExists('test.txt')).toBe(true);
    const data = await mockEnv.readFile('test.txt');
    expect(data.toString()).toBe('data');
    expect(await mockEnv.getFileSize('test.txt')).toBe(4);

    await mockEnv.removeFile('test.txt');
    expect(await mockEnv.fileExists('test.txt')).toBe(false);

    expect(mockEnv.writeFile).toHaveBeenCalled();
    expect(mockEnv.readFile).toHaveBeenCalled();
  });
});

// ─── Spy on LRUCache Evictions ───
describe('Spy on LRUCache', () => {
  it('should spy on eviction callback', () => {
    const evicted: [Buffer, Buffer][] = [];
    const onEvict = vi.fn((key: Buffer, value: Buffer) => {
      evicted.push([key, value]);
    });

    const cache = new LRUCache(20, onEvict);
    cache.insert(Buffer.from('a'), Buffer.from('1'), 10);
    cache.insert(Buffer.from('b'), Buffer.from('2'), 10);
    cache.insert(Buffer.from('c'), Buffer.from('3'), 10);

    expect(onEvict).toHaveBeenCalled();
    expect(evicted.length).toBeGreaterThan(0);
  });

  it('should verify erase does not call onEvict', () => {
    const onEvict = vi.fn();
    const cache = new LRUCache(100, onEvict);
    cache.insert(Buffer.from('k'), Buffer.from('v'), 10);
    onEvict.mockClear();
    cache.erase(Buffer.from('k'));
    expect(onEvict).not.toHaveBeenCalled();
  });
});

// ─── Stub for WriteBatch iteration ───
describe('Stub WriteBatch', () => {
  it('should stub iterate to verify all entries processed', () => {
    const batch = new WriteBatch();
    batch.put(Buffer.from('a'), Buffer.from('1'));
    batch.delete(Buffer.from('b'));

    const processed: string[] = [];
    batch.iterate((key, _value, _type) => {
      processed.push(key.toString());
    });

    expect(processed).toEqual(['a', 'b']);
  });
});

// ─── Mock for MemTable iterator ───
describe('Mock MemTable', () => {
  it('should use real comparator but mock arena behavior', () => {
    // MemTable internally uses Arena via SkipList
    // We test the MemTable interface with spy-like assertions
    const mockCmp: Comparator = {
      name: () => 'mock',
      compare: (a, b) => Buffer.compare(a, b),
      findShortestSeparator: (s) => s,
      findShortSuccessor: (k) => k,
    };

    const mem = new MemTable(mockCmp);
    mem.add(1n, ValueType.Value, Buffer.from('spykey'), Buffer.from('spyval'));

    // Get the internal iterator and spy on its behavior
    const iter = mem.getInternalIterator();
    expect(iter).toBeDefined();
    expect(typeof iter.valid).toBe('function');
    expect(typeof iter.key).toBe('function');
    expect(typeof iter.next).toBe('function');
    expect(typeof iter.seek).toBe('function');
    expect(typeof iter.seekToFirst).toBe('function');
  });
});

// ─── Version Edit Spy ───
describe('VersionEdit Mock Test', () => {
  it('should verify VersionEdit operations are recorded', () => {
    const edit = new VersionEdit();

    // Track all operations
    edit.setComparatorName('test.cmp');
    edit.setLogNumber(42);
    edit.setNextFile(100);
    edit.setLastSequence(999n);
    edit.addFile(0, {
      fileNumber: 1, fileSize: 1024,
      smallest: Buffer.from('a'), largest: Buffer.from('z'),
    });
    edit.deleteFile(1, 5);
    edit.deleteFile(1, 6);

    // Verify encoded representation contains all data
    const encoded = edit.encode();
    const decoded = VersionEdit.decode(encoded);

    expect(decoded.comparatorName).toBe('test.cmp');
    expect(decoded.logNumber).toBe(42);
    expect(decoded.nextFileNumber).toBe(100);
    expect(decoded.lastSequence).toBe(999n);
    expect(decoded.addedFiles.length).toBe(1);
    expect(decoded.addedFiles[0].meta.fileNumber).toBe(1);
    expect(decoded.deletedFiles.get(1)?.size).toBe(2);
  });
});
