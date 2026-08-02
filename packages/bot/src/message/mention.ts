import type { OneBotOutgoingMessage, OneBotOutgoingMessageSegment } from "@/onebot/websocket-client";

export interface MentionableUser {
  nickname: string | null;
  platformId: string;
}

/**
 * 将自然文本中的 @昵称 转换为 OneBot 原生提及消息段。
 * 候选用户应按最近交互时间排序；同名时保留第一个，昵称前缀冲突时优先匹配更长的昵称。
 */
export function resolveMentions(text: string, users: MentionableUser[]): OneBotOutgoingMessage {
  if (!text.includes("@") || users.length === 0) return text;

  const uniqueUsers = Array.from(
    users
      .reduce((byNickname, user) => {
        const nickname = user.nickname?.trim();
        if (nickname && !byNickname.has(nickname)) byNickname.set(nickname, user);
        return byNickname;
      }, new Map<string, MentionableUser>())
      .entries(),
  )
    .map(([nickname, user]) => ({ nickname, platformId: user.platformId }))
    .sort((a, b) => b.nickname.length - a.nickname.length);

  const result: OneBotOutgoingMessageSegment[] = [];
  let textStart = 0;
  let cursor = 0;

  while (cursor < text.length) {
    const atIndex = text.indexOf("@", cursor);
    if (atIndex < 0) break;

    const previous = text[atIndex - 1];
    if (previous && /[A-Za-z0-9._%+-]/.test(previous)) {
      cursor = atIndex + 1;
      continue;
    }

    const target = uniqueUsers.find(({ nickname }) => {
      if (!text.startsWith(nickname, atIndex + 1)) return false;

      const lastNicknameChar = nickname.at(-1)!;
      const next = text[atIndex + nickname.length + 1];
      return !(/[A-Za-z0-9_]/.test(lastNicknameChar) && next && /[A-Za-z0-9_]/.test(next));
    });
    if (!target) {
      cursor = atIndex + 1;
      continue;
    }

    if (atIndex > textStart) {
      result.push({ type: "text", data: { text: text.slice(textStart, atIndex) } });
    }
    result.push({ type: "at", data: { qq: target.platformId } });

    cursor = atIndex + target.nickname.length + 1;
    textStart = cursor;
  }

  if (result.length === 0) return text;
  if (textStart < text.length) {
    result.push({ type: "text", data: { text: text.slice(textStart) } });
  }
  return result;
}
