export interface NapCatLogger {
  trace(data: unknown, message?: string): void;
  debug(data: unknown, message?: string): void;
  info(data: unknown, message?: string): void;
  warn(data: unknown, message?: string): void;
  error(data: unknown, message?: string): void;
}

const ignoreLog = () => {};

export const noopLogger: NapCatLogger = {
  trace: ignoreLog,
  debug: ignoreLog,
  info: ignoreLog,
  warn: ignoreLog,
  error: ignoreLog,
};
