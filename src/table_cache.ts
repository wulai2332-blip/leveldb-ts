import { LRUCache } from './cache.js';
import { Table } from './sstable/table.js';

export class TableCache {
  private cache: LRUCache;
  private tableMap = new Map<number, Table>();

  constructor(maxOpenFiles: number) {
    this.cache = new LRUCache(maxOpenFiles, (key: Buffer) => {
      const fileNumber = Number(key.readBigUInt64BE(0));
      this.tableMap.delete(fileNumber);
    });
  }

  async getTable(filename: string, fileNumber: number, verifyChecksums: boolean = false): Promise<Table> {
    const key = this.makeKey(fileNumber);
    const handle = this.cache.lookup(key);
    if (handle) {
      const table = this.tableMap.get(fileNumber);
      if (table) return table;
    }
    const table = await Table.open(filename, verifyChecksums);
    this.cache.insert(key, Buffer.from([0]), 1);
    this.tableMap.set(fileNumber, table);
    return table;
  }

  evict(fileNumber: number): void {
    const key = this.makeKey(fileNumber);
    this.tableMap.delete(fileNumber);
    this.cache.erase(key);
  }

  private makeKey(fileNumber: number): Buffer {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(fileNumber), 0);
    return buf;
  }
}
