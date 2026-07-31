import { lstat } from "node:fs/promises";
import { tool } from "ai";
import { z } from "zod";
import { sanitizeImagePath, virtualToRealPath } from "@/utils/image-cache";

const escapeXml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function manageSticker() {
  return tool({
    description:
      "管理你可以在后续对话中复用的个人贴纸库。" +
      "当用户明确要求收藏图片为贴纸，或当前图片具有明确、可复用的情绪表达价值时，可以新增贴纸；不应收藏普通照片、隐私图片或含义不明确的图片。" +
      "新增时必须使用对话上下文中已有的图片路径，并提供简短且唯一的贴纸名以及准确描述。" +
      "贴纸名决定发送时使用的 [贴纸名]。贴纸库最多保留 15 张，新增超限时会自动移除最旧贴纸。也可以按名称移除不再需要的贴纸。",
    inputSchema: z.discriminatedUnion("action", [
      z.object({
        action: z.literal("add").describe("新增或替换贴纸"),
        name: z
          .string()
          .min(2)
          .max(32)
          .regex(/^[\p{L}][\p{L}\p{N}_-]+$/u)
          .describe("贴纸名，以字母开头，只能包含字母、数字、下划线或连字符，例如 开心、震惊、晚安"),
        image_path: z.string().describe("对话上下文中已有的图片路径"),
        description: z
          .string()
          .min(1)
          .max(500)
          .describe("图片内容、情绪含义和适用场景的简洁描述，供以后判断何时使用该贴纸"),
      }),
      z.object({
        action: z.literal("remove").describe("移除贴纸"),
        name: z.string().min(2).max(32).describe("要移除的贴纸名"),
      }),
    ]),
    execute: async (input) => {
      return "";
    },
  });
}
