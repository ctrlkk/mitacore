import pino, { type LoggerOptions, type Logger as PinoLogger } from "pino";

const prettyEnabled =
  process.env.LOG_PRETTY === "1" || (process.stdout.isTTY === true && process.env.LOG_PRETTY !== "0");

const options: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? "debug",
};

if (prettyEnabled) {
  options.transport = {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "HH:MM:ss.l",
      ignore: "pid,hostname",
    },
  };
}

export const logger: PinoLogger = pino(options);
