import { pino, type LoggerOptions, type Logger as PinoLogger } from "pino";
import pretty from "pino-pretty";

export type { PinoLogger, LoggerOptions };

const prettyEnabled =
  process.env.LOG_PRETTY === "1" || (process.stdout.isTTY === true && process.env.LOG_PRETTY !== "0");

const baseOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
};

export const logger: PinoLogger = prettyEnabled
  ? pino(
      baseOptions,
      pretty({
        colorize: true,
        translateTime: "HH:MM:ss.l",
        ignore: "pid,hostname",
      }),
    )
  : pino(baseOptions);
