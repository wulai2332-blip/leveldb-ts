import type { DBOptions, ReadOptions, WriteOptions } from './options.js';
import type { WriteBatch } from './write_batch.js';
import type { Iterator } from './iterator.js';
import type { Snapshot } from './snapshot.js';
import type { Range } from './types.js';

export abstract class DB {
  static async open(name: string, options: DBOptions = {}): Promise<DB> {
    const { DBImpl } = await import('./db_impl.js');
    return DBImpl.open(name, options);
  }

  static async destroyDB(name: string): Promise<void> {
    const { DBImpl } = await import('./db_impl.js');
    return DBImpl.destroyDB(name);
  }

  abstract get(key: string | Buffer, options?: ReadOptions): Promise<string | Buffer | null>;
  abstract put(key: string | Buffer, value: string | Buffer, options?: WriteOptions): Promise<void>;
  abstract delete(key: string | Buffer, options?: WriteOptions): Promise<void>;
  abstract write(batch: WriteBatch, options?: WriteOptions): Promise<void>;
  abstract iterator(options?: ReadOptions): Iterator;
  abstract getSnapshot(): Snapshot;
  abstract releaseSnapshot(snapshot: Snapshot): void;
  abstract getProperty(property: string): string;
  abstract getApproximateSizes(ranges: Range[]): bigint[];
  abstract compactRange(begin?: Buffer, end?: Buffer): Promise<void>;
  abstract close(): Promise<void>;
}
