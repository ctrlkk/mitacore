import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import zhCn from "dayjs/locale/zh-cn";

dayjs.locale(zhCn);
dayjs.extend(relativeTime);

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default dayjs;
