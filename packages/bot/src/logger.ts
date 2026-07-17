import pino, { type LoggerOptions, type Logger as PinoLogger, type DestinationStream } from "pino";
import { rename, readdir, unlink } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dataPath } from "@/utils/path";
import pretty from "pino-pretty";
import dayjs from "dayjs";

export type { PinoLogger, LoggerOptions };

const prettyEnabled = process.stdout.isTTY === true && process.env.LOG_PRETTY !== "0";
const baseOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
};

const createLogger = (): PinoLogger => {
  mkdirSync(dataPath("logs"), { recursive: true });

  const logFile = dataPath("logs", "app.jsonl");
  const dest = pino.destination(logFile);

  const rotateLog = async () => {
    const yesterday = dayjs().subtract(1, "day").format("YYYY-MM-DD");
    try {
      await rename(logFile, dataPath("logs", `app-${yesterday}.jsonl`));
      dest.reopen();
    } catch {
      // 忽略文件不存在等错误
    }

    const files = await readdir(dataPath("logs"));
    const cutoff = dayjs().subtract(3, "day");
    await Promise.all(
      files.map(async (file) => {
        const match = file.match(/^app-(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (!match || !dayjs(match[1]).isBefore(cutoff)) return;

        await unlink(dataPath("logs", file)).catch(() => {});
      }),
    );

    const msUntilMidnight = dayjs().add(1, "day").startOf("day").diff(dayjs());
    setTimeout(rotateLog, msUntilMidnight).unref();
  };

  const msUntilMidnight = dayjs().add(1, "day").startOf("day").diff(dayjs());
  setTimeout(rotateLog, msUntilMidnight).unref();

  const streams: { stream: DestinationStream }[] = [{ stream: dest }];

  if (prettyEnabled) {
    streams.push({
      stream: pretty({
        colorize: true,
        translateTime: "HH:MM:ss.l",
        ignore: "pid,hostname",
      }),
    });
  } else {
    streams.push({
      stream: process.stdout,
    });
  }

  return pino(baseOptions, pino.multistream(streams));
};

export const logger: PinoLogger = createLogger();
