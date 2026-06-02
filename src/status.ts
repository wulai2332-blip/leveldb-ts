export enum StatusCode {
  OK = 0,
  NotFound = 1,
  Corruption = 2,
  NotSupported = 3,
  IOError = 4,
}

export class Status {
  private constructor(
    private readonly code: StatusCode,
    private readonly msg: string = ''
  ) {}

  static ok(): Status {
    return new Status(StatusCode.OK);
  }

  static notFound(msg: string): Status {
    return new Status(StatusCode.NotFound, msg);
  }

  static corruption(msg: string): Status {
    return new Status(StatusCode.Corruption, msg);
  }

  static notSupported(msg: string): Status {
    return new Status(StatusCode.NotSupported, msg);
  }

  static ioError(msg: string): Status {
    return new Status(StatusCode.IOError, msg);
  }

  ok(): boolean {
    return this.code === StatusCode.OK;
  }

  isNotFound(): boolean {
    return this.code === StatusCode.NotFound;
  }

  isCorruption(): boolean {
    return this.code === StatusCode.Corruption;
  }

  isIOError(): boolean {
    return this.code === StatusCode.IOError;
  }

  isNotSupported(): boolean {
    return this.code === StatusCode.NotSupported;
  }

  toString(): string {
    if (this.ok()) return 'OK';
    const labels: Record<StatusCode, string> = {
      [StatusCode.OK]: '',
      [StatusCode.NotFound]: 'NotFound',
      [StatusCode.Corruption]: 'Corruption',
      [StatusCode.NotSupported]: 'NotSupported',
      [StatusCode.IOError]: 'IOError',
    };
    return `${labels[this.code]}: ${this.msg}`;
  }
}
