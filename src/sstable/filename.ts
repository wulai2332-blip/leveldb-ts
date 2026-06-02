import { join } from 'node:path';

export function tableFileName(dbname: string, fileNumber: number): string {
  return join(dbname, `${String(fileNumber).padStart(6, '0')}.ldb`);
}

export function logFileName(dbname: string, fileNumber: number): string {
  return join(dbname, `${String(fileNumber).padStart(6, '0')}.log`);
}
