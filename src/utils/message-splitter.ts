/**
 * 消息分割器
 * 将 LLM 输出的长文本分割为多条可发送的短消息。
 */

export interface SplitterConfig {
  enable: boolean;
  maxLength: number;
  maxSentenceNum: number;
  maxSplitNum: number;
  enableKaomojiProtection: boolean;
  enableOverflowReturnAll: boolean;
}

const DEFAULT_CONFIG: SplitterConfig = {
  enable: true,
  maxLength: 512,
  maxSentenceNum: 10,
  maxSplitNum: 3,
  enableKaomojiProtection: false,
  enableOverflowReturnAll: true,
};

function getWesternRatio(paragraph: string): number {
  const chars = [...paragraph];
  const alnumChars = chars.filter((c) => /[a-zA-Z0-9]/.test(c));
  if (alnumChars.length === 0) return 0;
  return alnumChars.filter((c) => /[a-zA-Z]/i.test(c)).length / alnumChars.length;
}

function protectKaomoji(sentence: string): { text: string; mapping: Map<string, string> } {
  const pattern =
    /([(\[（【](?![^()\[\]（）【】]*[\u4e00-\u9fa5])[^()\[\]（）【】]*?[^\u4e00-\u9fa5a-zA-Z0-9\s][^()\[\]（）【】]*?[)\]）】])|([▼▽・ᴥω･﹏^><≧≦￣｀´∀ヮДд︿﹀へ｡ﾟ╥╯╰︶︹•⁄]{2,15})/g;
  const mapping = new Map<string, string>();
  let idx = 0;
  const text = sentence.replace(pattern, (match) => {
    const placeholder = `__KAOMOJI_${idx}__`;
    mapping.set(placeholder, match);
    idx++;
    return placeholder;
  });
  return { text, mapping };
}

function recoverKaomoji(sentences: string[], mapping: Map<string, string>): string[] {
  return sentences.map((s) => {
    for (const [placeholder, kaomoji] of mapping) {
      s = s.replaceAll(placeholder, kaomoji);
    }
    return s;
  });
}

const TRAILING_PUNCTUATION = /[。；，,\s]+$/;

function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);
}

function splitIntoSentences(text: string): string[] {
  const sentences: string[] = [];
  let current = "";

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    current += ch;

    if (/[。；？！]/.test(ch)) {
      sentences.push(current.trim());
      current = "";
      continue;
    }

    if (ch === "…" && text[i + 1] === "…") {
      current += "…";
      i++;
      sentences.push(current.trim());
      current = "";
    }
  }

  if (current.trim()) sentences.push(current.trim());
  return sentences.filter(Boolean);
}

function groupSentences(paragraphs: string[][], targetLength: number, maxLength: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const sentences of paragraphs) {
    for (const sentence of sentences) {
      const shouldSplit = current && (current.length >= targetLength || current.length + sentence.length > maxLength);
      if (shouldSplit) {
        chunks.push(current);
        current = sentence;
        continue;
      }
      current += sentence;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function mergeChunks(chunks: string[], maxCount: number): string[] {
  if (chunks.length <= maxCount) return chunks;

  const result = chunks.slice();
  while (result.length > maxCount) {
    let minIdx = 0;
    let minLen = result[0]!.length + result[1]!.length;
    for (let i = 1; i < result.length - 1; i++) {
      const len = result[i]!.length + result[i + 1]!.length;
      if (len < minLen) {
        minLen = len;
        minIdx = i;
      }
    }
    result[minIdx] = result[minIdx]! + result[minIdx + 1]!;
    result.splice(minIdx + 1, 1);
  }
  return result;
}

const DEFAULT_REPLIES = ["不知道哦", "不知道", "不晓得", "懒得说", "()"];

function getRandomDefaultReply(): string {
  return DEFAULT_REPLIES[Math.floor(Math.random() * DEFAULT_REPLIES.length)]!;
}

export function splitMessage(text: string, config: Partial<SplitterConfig> = {}): string[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (!cfg.enable) return [text];

  let protectedText = text;
  let kaomojiMapping = new Map<string, string>();
  if (cfg.enableKaomojiProtection) {
    const result = protectKaomoji(text);
    protectedText = result.text;
    kaomojiMapping = result.mapping;
  }

  const bracketPattern = /(?:（[^）]*?[\u4e00-\u9fff][^）]*?）|\[[^\]]*?[\u4e00-\u9fff][^\]]*?\])/g;
  const cleanedText = protectedText.replace(bracketPattern, "");
  if (!cleanedText.trim()) return ["呃呃"];

  const maxLength = cfg.maxLength * 2;
  if (getWesternRatio(cleanedText) < 0.1 && cleanedText.length > maxLength) {
    return [getRandomDefaultReply()];
  }

  const paragraphSentences = splitParagraphs(cleanedText).map(splitIntoSentences);
  if (paragraphSentences.flat().length > cfg.maxSentenceNum) {
    return cfg.enableOverflowReturnAll ? [cleanedText] : [getRandomDefaultReply()];
  }

  const targetLength = Math.max(1, Math.floor(cleanedText.length / cfg.maxSplitNum));
  let chunks = groupSentences(paragraphSentences, targetLength, maxLength);
  chunks = mergeChunks(chunks, cfg.maxSplitNum)
    .map((c) => c.replace(TRAILING_PUNCTUATION, ""))
    .filter(Boolean);

  if (chunks.length === 0) return [cleanedText];

  if (cfg.enableKaomojiProtection) {
    chunks = recoverKaomoji(chunks, kaomojiMapping);
  }

  return chunks;
}
