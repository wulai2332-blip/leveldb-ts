import { DB } from '../src/db.js';
import { existsSync, rmSync } from 'node:fs';

const DB_DIR = 'benchmarks/_bench_db';
const NUM_ENTRIES = 10_000;

async function main() {
  if (existsSync(DB_DIR)) rmSync(DB_DIR, { recursive: true, force: true });

  // Open
  console.time('open');
  const db = await DB.open(DB_DIR, { createIfMissing: true });
  console.timeEnd('open');

  // Sequential write
  console.time(`fillseq (${NUM_ENTRIES})`);
  for (let i = 0; i < NUM_ENTRIES; i++) {
    const key = Buffer.from(`key${String(i).padStart(8, '0')}`);
    const val = Buffer.from(`value${i}`);
    await db.put(key, val);
  }
  console.timeEnd(`fillseq (${NUM_ENTRIES})`);

  // Random read
  console.time(`readrandom (${NUM_ENTRIES})`);
  for (let i = 0; i < NUM_ENTRIES; i++) {
    const idx = Math.floor(Math.random() * NUM_ENTRIES);
    const key = Buffer.from(`key${String(idx).padStart(8, '0')}`);
    await db.get(key);
  }
  console.timeEnd(`readrandom (${NUM_ENTRIES})`);

  await db.close();
  console.log('Benchmark done.');
}

main().catch(console.error);
