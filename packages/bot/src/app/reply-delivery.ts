import { sleep } from "shared/time";
import type { ChannelReplyContext } from "@/channel/types";
import type { AudioPart, ReplyOutput } from "@/message/parts";
import type { PendingMessage } from "@/message/types";
import { listMentionableUserAliases } from "@/database/user-alias";
import { logger, type PinoLogger } from "@/logger";
import { synthesizeReplySpeech } from "@/agents/tts/reply-speech";

type SpeechSynthesizer = (text: string, contextText?: string, log?: PinoLogger) => Promise<AudioPart>;

interface ReplyDeliveryOptions {
  delayMs?: number;
  synthesizeSpeech?: SpeechSynthesizer;
}

/**
 * 从待处理消息中提取最新的用户文本消息。
 * @param batch 待处理消息数组。
 * @returns 最新的用户文本消息，如果不存在则返回 undefined。
 */
export function getLatestUserText(batch: PendingMessage[]): string | undefined {
  const latestMessage = batch.at(-1);
  const text = latestMessage?.unifiedMessages
    .flatMap((segment) => (segment.type === "text" ? [segment.text] : []))
    .join("")
    .trim();
  return text || undefined;
}

/**
 * 发送回复消息。
 * @param output 回复消息。
 * @param ctx 回复上下文。
 * @param contextText 上下文文本，用于语音合成。
 * @param log 日志记录器。
 * @param options 回复交付选项。
 */
export async function deliverReply(
  output: ReplyOutput,
  ctx: ChannelReplyContext,
  contextText: string | undefined,
  log: PinoLogger = logger,
  options: ReplyDeliveryOptions = {},
) {
  const mentionableUsers = (() => {
    if (ctx.platform !== "onebot" || ctx.conversationType !== "group") return [];
    if (!output.segments.some((segment) => typeof segment === "string" && segment.includes("@"))) return [];
    return listMentionableUserAliases("onebot").filter((user) => user.platformId !== ctx.selfId);
  })();

  const synthesizeSpeech = options.synthesizeSpeech ?? synthesizeReplySpeech;
  const speechPromise =
    ctx.platform === "onebot" && output.speechText && process.env.DUBAO_API_KEY
      ? synthesizeSpeech(output.speechText, contextText, log).catch((error) => {
          log.warn({ error }, "回复语音合成失败，已降级为文本");
          return undefined;
        })
      : Promise.resolve(undefined);

  const delayMs = options.delayMs ?? 500;
  for (const segment of output.segments) {
    await ctx.reply(segment, mentionableUsers);
    await sleep(delayMs);
  }

  const speech = await speechPromise;
  if (speech) {
    await ctx.reply(speech).catch((error) => {
      log.warn({ error }, "回复语音发送失败，已保留文本");
    });
  }
}
