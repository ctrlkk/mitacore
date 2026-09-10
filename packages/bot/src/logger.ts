import pino, {
  type LoggerOptions,
  type Logger as PinoLogger,
  type LevelWithSilentOrString,
  type StreamEntry,
} from "pino";
import { rename, readdir, unlink } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dataPath } from "@/utils/path";
import pretty from "pino-pretty";
import dayjs from "shared/time";

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

  const streams: StreamEntry<LevelWithSilentOrString>[] = [{ stream: dest, level: baseOptions.level }];

  if (prettyEnabled) {
    streams.push({
      stream: pretty({
        // 直接写入 fd 在 Windows 传统代码页中会将 UTF-8 字节错误解码为乱码；
        // 使用 Node 的 stdout 让其通过控制台 Unicode API 输出。
        destination: process.stdout,
        colorize: true,
        translateTime: "SYS:HH:MM:ss.l",
        ignore: "pid,hostname",
      }),
      level: baseOptions.level,
    });
  } else {
    streams.push({
      stream: process.stdout,
      level: baseOptions.level,
    });
  }

  return pino(baseOptions, pino.multistream(streams));
};

export const logger: PinoLogger = createLogger();
