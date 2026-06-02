# leveldb-ts

A TypeScript-native LevelDB-compatible embedded key-value storage engine, built from scratch with zero C++ native addon dependencies.

## Features

- **LSM-Tree Architecture** — MemTable (SkipList) → WAL → SSTable → Compaction, faithful to LevelDB's design
- **Zero Native Dependencies** — All data structures hand-written in pure TypeScript (SkipList, LRU Cache, Bloom Filter, Varint, CRC32)
- **Async I/O** — Built on `fs/promises` for non-blocking file operations
- **Worker Thread Compaction** — Background compaction runs off the main thread via `Worker Threads`
- **Compression** — Supports Snappy and Zstd compression for SSTable data blocks
- **Full Feature Parity** — Put/Get/Delete, WriteBatch, Snapshot, Range Iteration, RepairDB, ApproximateSizes
- **String & Buffer** — Optional UTF-8 key/value encoding so you can pass plain strings
- **Comprehensive Test Suite** — 472 tests across 21 testing methodologies, 100% module coverage
- **TypeScript First** — Full type declarations included, strict mode enabled

## Installation

```bash
npm install @wulai/leveldb-ts
```

Requires Node.js >= 20.

## Quick Start

```ts
import { DB } from '@wulai/leveldb-ts';

// Open (or create) a database
const db = await DB.open('./mydb', { createIfMissing: true });

// Write
await db.put(Buffer.from('hello'), Buffer.from('world'));

// Read
const value = await db.get(Buffer.from('hello'));
console.log(value?.toString()); // 'world'

// Delete
await db.delete(Buffer.from('hello'));

// Batch writes
import { WriteBatch } from '@wulai/leveldb-ts';
const batch = new WriteBatch();
batch.put(Buffer.from('a'), Buffer.from('1'));
batch.put(Buffer.from('b'), Buffer.from('2'));
batch.delete(Buffer.from('c'));
await db.write(batch);

// Snapshot reads
const snap = db.getSnapshot();
const val = await db.get(Buffer.from('a'), { snapshot: snap });
db.releaseSnapshot(snap);

// Range iteration
const iter = db.iterator();
await iter.seekToFirst();
while (iter.valid()) {
  console.log(iter.key().toString(), '=', iter.value().toString());
  await iter.next();
}
iter.close();

// Clean up
await db.close();
```

### Using string keys/values

```ts
const db = await DB.open('./strdb', {
  createIfMissing: true,
  keyEncoding: 'utf8',
  valueEncoding: 'utf8',
});

await db.put('name', 'arlei');
const name = await db.get('name');
console.log(name); // 'arlei'
```

## API Reference

### `DB.open(name: string, options?: DBOptions): Promise<DB>`

Opens a database. Creates it if `createIfMissing` is `true`.

### `db.get(key: Buffer, options?: ReadOptions): Promise<Buffer | null>`

Retrieves the value for `key`. Returns `null` if not found.

### `db.put(key: Buffer, value: Buffer, options?: WriteOptions): Promise<void>`

Stores a key-value pair.

### `db.delete(key: Buffer, options?: WriteOptions): Promise<void>`

Removes a key. Deleting a non-existent key is not an error.

### `db.write(batch: WriteBatch, options?: WriteOptions): Promise<void>`

Atomically applies a batch of operations.

### `db.iterator(options?: ReadOptions): Iterator`

Creates an iterator over the database contents.

### `db.getSnapshot(): Snapshot`

Returns a snapshot of the current state. Snapshots provide a consistent read view.

### `db.releaseSnapshot(snapshot: Snapshot): void`

Releases a previously acquired snapshot.

### `db.getProperty(property: string): string`

Returns internal statistics.

### `db.getApproximateSizes(ranges: Range[]): bigint[]`

Estimates disk space used for key ranges.

### `db.compactRange(begin?: Buffer, end?: Buffer): Promise<void>`

Manually triggers compaction for a key range.

### `db.close(): Promise<void>`

Closes the database, releasing all resources.

### `Iterator`

```ts
class Iterator implements AsyncDisposable {
  async seekToFirst(): Promise<void>;
  async seekToLast(): Promise<void>;
  async seek(target: Buffer): Promise<void>;
  async next(): Promise<void>;
  async prev(): Promise<void>;
  valid(): boolean;
  key(): Buffer;
  value(): Buffer;
  status(): Status;
  close(): void;
  [Symbol.asyncDispose](): Promise<void>;
  [Symbol.asyncIterator](): AsyncIterator<{ key: Buffer; value: Buffer }>;
}
```

### `WriteBatch`

```ts
class WriteBatch {
  put(key: Buffer, value: Buffer): void;
  delete(key: Buffer): void;
  clear(): void;
  approxSize(): number;
}
```

### `Snapshot`

```ts
class Snapshot implements Disposable {
  readonly sequence: bigint;
  [Symbol.dispose](): void;
}
```

## Configuration

### `DBOptions`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `createIfMissing` | `boolean` | `false` | Create DB if directory doesn't exist |
| `errorIfExists` | `boolean` | `false` | Error if DB already exists |
| `paranoidChecks` | `boolean` | `false` | Extra CRC verification on reads |
| `writeBufferSize` | `number` | `4MB` | MemTable size before flush |
| `maxOpenFiles` | `number` | `1000` | Max concurrently open files |
| `blockSize` | `number` | `4096` | SSTable data block size (bytes) |
| `blockRestartInterval` | `number` | `16` | Delta encoding restart interval |
| `maxFileSize` | `number` | `2MB` | Max SSTable file size |
| `compression` | `CompressionType` | `Snappy` | Block compression: `None`, `Snappy`, or `Zstd` |
| `zstdCompressionLevel` | `number` | `1` | Zstd compression level |
| `filterPolicy` | `FilterPolicy` | — | Bloom filter policy for SSTable |
| `comparator` | `Comparator` | `BytewiseComparator` | Custom key ordering |
| `blockCache` | `LRUCache` | — | Block-level LRU cache |
| `env` | `Env` | `NodeEnv` | File system abstraction |
| `logger` | `Logger` | — | Custom logger implementation |
| `keyEncoding` | `'utf8' \| 'buffer'` | `'buffer'` | Key encoding for public API |
| `valueEncoding` | `'utf8' \| 'buffer'` | `'buffer'` | Value encoding for public API |

### `ReadOptions`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `verifyChecksums` | `boolean` | `false` | Verify block checksums on read |
| `fillCache` | `boolean` | `true` | Whether reads populate the block cache |
| `snapshot` | `Snapshot \| null` | — | Read at a specific snapshot |

### `WriteOptions`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sync` | `boolean` | `false` | fsync WAL before returning |

## Architecture

```
Public API (DB.open / get / put / delete / write / iterator / snapshot)
    │
DBImpl (core scheduler: MemTable / WAL / Version / Compaction)
    │
    ├── MemTable (SkipList) ── Write buffer, sorted in memory
    ├── WAL (.log) ── Append-only log, crash recovery
    ├── Version / MANIFEST ── File version management
    ├── SSTable (.ldb) ── Sorted persistent files
    ├── Compaction ── Worker Thread background merging
    ├── Cache (LRU) ── Block + Table two-level cache
    └── Env ── File system abstraction layer
```

### Write Path

`Put` → Build WriteBatch → Acquire write lock → Assign SeqNum → Write WAL → Write MemTable → Release lock → Check threshold (exceeded → flush to SSTable)

### Read Path

`Get` → Acquire Snapshot SeqNum → Check active MemTable → Check Immutable MemTable → Level-0 to Level-N SSTable scan (Bloom Filter → DataBlock) → Find latest visible version or NotFound

### File Format

- **SSTable (.ldb)**: DataBlock(s) → FilterBlock → MetaIndexBlock → IndexBlock → Footer (48B)
- **WAL (.log)**: 32KB fixed-size blocks, CRC32 + length + type header per record
- **MANIFEST**: Sequence of VersionEdit records in WAL format

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Run full methodology test suite
npm run test:all

# Run benchmarks
npm bench

# Build for production
npm run build

# Lint & format
npm run lint
npm run format
```

### Project Structure

```
src/
├── index.ts              # Public API exports
├── db.ts / db_impl.ts    # DB abstraction + core implementation
├── types.ts              # SequenceNumber, InternalKey, FileMetaData, ValueType
├── codec.ts              # Varint codec + CRC32
├── comparator.ts         # BytewiseComparator + Comparator interface
├── options.ts            # DBOptions, ReadOptions, WriteOptions
├── status.ts / error.ts  # Status codes + LevelDBError hierarchy
├── snapshot.ts           # Snapshot with Disposable support
├── write_batch.ts        # Atomic batch operations
├── iterator.ts           # Iterator + DBIter + MergingIterator
├── cache.ts              # Generic LRU Cache
├── table_cache.ts        # SSTable-level cache
├── arena.ts              # Arena memory allocator
├── logger.ts             # Logger interface + ConsoleLogger
├── env.ts                # Env abstraction + NodeEnv (fs/promises)
├── repair.ts             # RepairDB
├── memtable.ts           # MemTable wrapper
├── memtable/
│   └── skiplist.ts       # SkipList implementation
├── wal/
│   ├── writer.ts         # LogWriter (32KB blocks)
│   └── reader.ts         # LogReader (CRC verification)
├── sstable/
│   ├── block.ts          # Block reader (restart-based iteration)
│   ├── block_builder.ts  # Block builder (shared prefix encoding)
│   ├── table.ts          # Table reader (two-level index)
│   ├── table_builder.ts  # Table builder (block + index + footer)
│   ├── bloom.ts          # BloomFilterPolicy
│   └── filename.ts       # SSTable file naming
├── version/
│   ├── version.ts        # Version (7-level file tracking)
│   ├── version_edit.ts   # VersionEdit (encode/decode)
│   ├── version_edit_tag.ts  # MANIFEST tag constants
│   └── version_set.ts    # VersionSet (MANIFEST + CURRENT)
└── compaction/
    ├── scheduler.ts      # Compaction scheduling
    └── worker.ts         # Worker Thread handler
```

## Testing

This project uses a rigorous 21-methodology test approach with 472 test cases covering all 34 source modules.

```bash
npm test           # Quick run
npm run test:all   # Full methodology suite (472 tests)
```

## License

MIT — see [LICENSE](./LICENSE) for details.
