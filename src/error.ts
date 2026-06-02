export class LevelDBError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'LevelDBError';
  }
}

export class NotFoundError extends LevelDBError {
  constructor(message: string) {
    super('NOT_FOUND', message);
    this.name = 'NotFoundError';
  }
}

export class CorruptionError extends LevelDBError {
  constructor(message: string) {
    super('CORRUPTION', message);
    this.name = 'CorruptionError';
  }
}

export class IOError extends LevelDBError {
  constructor(message: string) {
    super('IO_ERROR', message);
    this.name = 'IOError';
  }
}

export function statusToError(s: {
  ok(): boolean;
  isNotFound(): boolean;
  isCorruption(): boolean;
  isIOError(): boolean;
  toString(): string;
}): void {
  if (s.ok()) return;
  if (s.isNotFound()) throw new NotFoundError(s.toString());
  if (s.isCorruption()) throw new CorruptionError(s.toString());
  if (s.isIOError()) throw new IOError(s.toString());
  throw new LevelDBError('UNKNOWN', s.toString());
}
