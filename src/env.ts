import { mkdirSync, rmSync, readdirSync, existsSync, statSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { readFile, writeFile, unlink, rename, stat } from 'node:fs/promises';

export interface Env {
  createDir(name: string): Promise<void>;
  removeDir(name: string): Promise<void>;
  readFile(filename: string): Promise<Buffer>;
  writeFile(filename: string, data: Buffer): Promise<void>;
  removeFile(filename: string): Promise<void>;
  renameFile(oldPath: string, newPath: string): Promise<void>;
  fileExists(filename: string): Promise<boolean>;
  getChildren(dir: string): Promise<string[]>;
  getFileSize(filename: string): Promise<number>;
  lockFile(filename: string): Promise<void>;
  unlockFile(filename: string): Promise<void>;
}

export class NodeEnv implements Env {
  async createDir(name: string): Promise<void> {
    if (!existsSync(name)) mkdirSync(name, { recursive: true });
  }

  async removeDir(name: string): Promise<void> {
    rmSync(name, { recursive: true, force: true });
  }

  async readFile(filename: string): Promise<Buffer> {
    return readFile(filename);
  }

  async writeFile(filename: string, data: Buffer): Promise<void> {
    await writeFile(filename, data);
  }

  async removeFile(filename: string): Promise<void> {
    await unlink(filename);
  }

  async renameFile(oldPath: string, newPath: string): Promise<void> {
    await rename(oldPath, newPath);
  }

  async fileExists(filename: string): Promise<boolean> {
    return existsSync(filename);
  }

  async getChildren(dir: string): Promise<string[]> {
    return readdirSync(dir);
  }

  async getFileSize(filename: string): Promise<number> {
    return (await stat(filename)).size;
  }

  async lockFile(filename: string): Promise<void> {
    if (existsSync(filename)) {
      const s = statSync(filename);
      if (s.isDirectory()) {
        throw new Error(`Cannot lock: '${filename}' is a directory, not a file`);
      }
    }
    const fd = openSync(filename, 'w');
    closeSync(fd);
  }

  async unlockFile(filename: string): Promise<void> {
    if (existsSync(filename)) unlinkSync(filename);
  }
}
