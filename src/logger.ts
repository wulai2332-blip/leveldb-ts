export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export class ConsoleLogger implements Logger {
  info(msg: string, ...args: unknown[]): void {
    console.log(`[INFO] ${msg}`, ...args);
  }
  warn(msg: string, ...args: unknown[]): void {
    console.warn(`[WARN] ${msg}`, ...args);
  }
  error(msg: string, ...args: unknown[]): void {
    console.error(`[ERROR] ${msg}`, ...args);
  }
}

export class NoopLogger implements Logger {
  info(_msg: string, ..._args: unknown[]): void {}
  warn(_msg: string, ..._args: unknown[]): void {}
  error(_msg: string, ..._args: unknown[]): void {}
}
