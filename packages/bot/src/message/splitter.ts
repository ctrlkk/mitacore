/**
 * 消息分割器
 * 将 LLM 输出的长文本分割为多条可发送的短消息。
 */

export interface SplitterConfig {
  enable: boolean;
  maxLength: number;
  maxSentenceNum: number;
  maxSplitNum: number;
  enableOverflowReturnAll: boolean;
}

const DEFAULT_CONFIG: SplitterConfig = {
  enable: true,
  maxLength: 512,
  maxSentenceNum: 10,
  maxSplitNum: 3,
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
const NARRATION_PATTERN = /(?:（[^）]*?[\u4e00-\u9fff][^）]*?）|\[[^\]]*?[\u4e00-\u9fff][^\]]*?\])/g;

/**
 * 按需移除回复中的括号旁白，同时保留用于历史记录和语音合成的完整标点。
 */
export function cleanMessage(text: string, removeBracketedNarration = true): string {
  if (!removeBracketedNarration) return text;
  const cleanedText = text.replace(NARRATION_PATTERN, "");
  return cleanedText.trim() ? cleanedText : "呃呃";
}

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

interface MessageChunk {
  text: string;
  /** 当前句子位于新段落开头；与前面的句子拼接时需保留段落边界。 */
  startsNewParagraph: boolean;
}

function groupSentences(paragraphs: string[][], maxCount: number): string[] {
  const sentences: MessageChunk[] = paragraphs.flatMap((paragraph, paragraphIndex) =>
    paragraph.map((text, sentenceIndex) => ({
      text,
      startsNewParagraph: paragraphIndex > 0 && sentenceIndex === 0,
    })),
  );
  if (sentences.length <= maxCount) return sentences.map((sentence) => sentence.text);

  const prefixLengths = [0];
  for (const sentence of sentences) {
    prefixLengths.push(
      prefixLengths[prefixLengths.length - 1]! + sentence.text.length + Number(sentence.startsNewParagraph),
    );
  }

  const targetLength = prefixLengths[sentences.length]! / maxCount;
  const costs: number[][] = Array.from({ length: maxCount + 1 }, () =>
    Array<number>(sentences.length + 1).fill(Infinity),
  );
  const splitPoints: number[][] = Array.from({ length: maxCount + 1 }, () =>
    Array<number>(sentences.length + 1).fill(-1),
  );
  costs[0]![0] = 0;

  // 从整体上最小化长度偏差，避免逐次合并相邻短句造成局部最优。
  for (let groupCount = 1; groupCount <= maxCount; groupCount++) {
    for (let end = groupCount; end <= sentences.length; end++) {
      for (let start = groupCount - 1; start < end; start++) {
        // 分组开头不需要段落分隔空格，只计算组内实际拼接长度。
        const length = prefixLengths[end]! - prefixLengths[start]! - Number(sentences[start]!.startsNewParagraph);
        const cost = costs[groupCount - 1]![start]! + (length - targetLength) ** 2;
        if (cost < costs[groupCount]![end]!) {
          costs[groupCount]![end] = cost;
          splitPoints[groupCount]![end] = start;
        }
      }
    }
  }

  const chunks: string[] = [];
  let end = sentences.length;
  for (let groupCount = maxCount; groupCount > 0; groupCount--) {
    const start = splitPoints[groupCount]![end]!;
    chunks.unshift(
      sentences
        .slice(start, end)
        .map((sentence, index) => (index > 0 && sentence.startsNewParagraph ? " " : "") + sentence.text)
        .join(""),
    );
    end = start;
  }
  return chunks;
}

const DEFAULT_REPLIES = [
  "这段有点长，我先不展开啦",
  "信息有点多，慢一点说也可以",
  "我一下没整理过来，换个说法试试？",
  "这个我暂时接不住，聊点别的也行",
  "我没太明白，可以再说具体一点吗？",
];

function getRandomDefaultReply(): string {
  return DEFAULT_REPLIES[Math.floor(Math.random() * DEFAULT_REPLIES.length)]!;
}

export function splitMessage(text: string, config: Partial<SplitterConfig> = {}): string[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (!cfg.enable) return [text];

  const { text: protectedText, mapping: kaomojiMapping } = protectKaomoji(text);

  const maxLength = cfg.maxLength * 2;
  if (getWesternRatio(protectedText) < 0.1 && protectedText.length > maxLength) {
    return [getRandomDefaultReply()];
  }

  const paragraphSentences = splitParagraphs(protectedText).map(splitIntoSentences);
  if (paragraphSentences.flat().length > cfg.maxSentenceNum) {
    return cfg.enableOverflowReturnAll ? [text] : [getRandomDefaultReply()];
  }

  const chunks = groupSentences(paragraphSentences, cfg.maxSplitNum)
    .map((chunk) => chunk.replace(TRAILING_PUNCTUATION, ""))
    .filter(Boolean);

  if (chunks.length === 0) return [text];

  return recoverKaomoji(chunks, kaomojiMapping);
}
