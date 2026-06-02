import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DB } from './db.js';
import type { DBOptions } from './options.js';

export async function repairDB(dbname: string, options: DBOptions = {}): Promise<void> {
  if (!existsSync(dbname)) throw new Error(`Database ${dbname} does not exist`);

  const files = readdirSync(dbname);

  // Delete lock file if stale
  const lockPath = join(dbname, 'LOCK');
  if (existsSync(lockPath)) {
    unlinkSync(lockPath);
  }

  // Re-create CURRENT based on latest MANIFEST
  const manifests = files.filter(f => f.startsWith('MANIFEST-')).sort();
  if (manifests.length > 0) {
    writeFileSync(join(dbname, 'CURRENT'), `${manifests[manifests.length - 1]}\n`);
  }

  // Try to open and close (validates recovery)
  const db = await DB.open(dbname, options);
  await db.close();
}
