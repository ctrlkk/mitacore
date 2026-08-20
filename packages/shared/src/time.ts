import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import zhCn from "dayjs/locale/zh-cn";

dayjs.locale(zhCn);
dayjs.extend(relativeTime);
dayjs.extend(utc);
dayjs.extend(timezone);

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getTimeInTimezone(date: Date, timezoneName: string): string {
  return dayjs(date).tz(timezoneName).format("HH:mm");
}

export function isValidTimezone(timezoneName: string): boolean {
  try {
    dayjs().tz(timezoneName);
    return true;
  } catch {
    return false;
  }
}

export default dayjs;
