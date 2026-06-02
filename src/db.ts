import type { DBOptions, ReadOptions, WriteOptions } from './options.js';
import type { WriteBatch } from './write_batch.js';
import type { Iterator } from './iterator.js';
import type { Snapshot } from './snapshot.js';

export abstract class DB {
  static async open(name: string, options: DBOptions = {}): Promise<DB> {
    const { DBImpl } = await import('./db_impl.js');
    return DBImpl.open(name, options);
  }

  abstract get(key: Buffer, options?: ReadOptions): Promise<Buffer | null>;
  abstract put(key: Buffer, value: Buffer, options?: WriteOptions): Promise<void>;
  abstract delete(key: Buffer, options?: WriteOptions): Promise<void>;
  abstract write(batch: WriteBatch, options?: WriteOptions): Promise<void>;
  abstract iterator(options?: ReadOptions): Iterator;
  abstract getSnapshot(): Snapshot;
  abstract releaseSnapshot(snapshot: Snapshot): void;
  abstract getProperty(property: string): string;
  abstract compactRange(begin?: Buffer, end?: Buffer): Promise<void>;
  abstract close(): Promise<void>;
}
