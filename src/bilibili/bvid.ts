/**
 * BV/AV 号互转算法
 *
 * 算法来源：https://www.zhihu.com/question/381784377/answer/1099438784
 * BV 号是 base58 编码 + XOR 混淆后的结果，B站前端用来替代纯数字的 av 号。
 *
 * XOR_CODE / MASK_CODE 是固定的密钥常量，不要改动。
 */

const XOR_CODE = 23442827791579n;
const MASK_CODE = 2251799813685247n;
const MAX_AID = 1n << 51n;
const BASE = 58;
const BV_LEN = 12;

/** base58 字母表（B站自定义顺序，注意大小写敏感） */
const DATA = "FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mSDQX9RdoZf";

/**
 * BV 号 → AV 号（数字）
 *
 * 1. 交换第 3/9 位, 第 4/7 位
 * 2. 去掉前 3 位 "BV1"
 * 3. base58 解码得到大整数
 * 4. & MASK_CODE 再 ^ XOR_CODE 得到 aid
 */
export function bvid2aid(bvid: string): number {
  const chars = [...bvid];
  const c3 = chars[3]!, c9 = chars[9]!;
  chars[3] = c9; chars[9] = c3;
  const c4 = chars[4]!, c7 = chars[7]!;
  chars[4] = c7; chars[7] = c4;
  const trimmed = chars.slice(3);
  let tmp = 0n;
  for (const c of trimmed) {
    const idx = BigInt(DATA.indexOf(c));
    tmp = tmp * BigInt(BASE) + idx;
  }
  return Number((tmp & MASK_CODE) ^ XOR_CODE);
}

/**
 * AV 号 → BV 号
 *
 * 逆运算：aid ^ XOR_CODE → base58 编码 → 位置置换 → 加 "BV1" 前缀
 */
export function aid2bvid(aid: number): string {
  const bytes = ["B", "V", "1", "0", "0", "0", "0", "0", "0", "0", "0", "0"];
  let bvIdx = BV_LEN - 1;
  let tmp = (MAX_AID | BigInt(aid)) ^ XOR_CODE;
  while (tmp !== 0n) {
    bytes[bvIdx] = DATA[Number(tmp % BigInt(BASE))]!;
    tmp /= BigInt(BASE);
    bvIdx--;
  }
  const c3 = bytes[3]!, c9 = bytes[9]!;
  bytes[3] = c9; bytes[9] = c3;
  const c4 = bytes[4]!, c7 = bytes[7]!;
  bytes[4] = c7; bytes[7] = c4;
  return bytes.join("");
}
