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
const NARRATION_PATTERN = /(?:（[^）]*?[\u4e00-\u9fff][^）]*?）|\[[^\]]*?[\u4e00-\u9fff][^\]]*?\])/g;

/**
 * 移除回复中的旁白，同时保留用于历史记录和语音合成的完整标点。
 */
export function cleanMessage(text: string): string {
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
  /** 当前片段原本位于新段落开头；与前一个片段重组时需保留段落边界。 */
  startsNewParagraph: boolean;
}

function groupSentences(paragraphs: string[][], targetLength: number, maxLength: number): MessageChunk[] {
  const chunks: MessageChunk[] = [];
  let current = "";
  let currentStartsNewParagraph = false;

  for (const [paragraphIndex, sentences] of paragraphs.entries()) {
    for (const [sentenceIndex, sentence] of sentences.entries()) {
      const startsNewParagraph = paragraphIndex > 0 && sentenceIndex === 0;
      const separator = startsNewParagraph && current ? " " : "";
      const shouldSplit =
        current && (current.length >= targetLength || current.length + separator.length + sentence.length > maxLength);
      if (shouldSplit) {
        chunks.push({ text: current, startsNewParagraph: currentStartsNewParagraph });
        current = sentence;
        currentStartsNewParagraph = startsNewParagraph;
        continue;
      }
      current += separator + sentence;
    }
  }

  if (current) chunks.push({ text: current, startsNewParagraph: currentStartsNewParagraph });
  return chunks;
}

function mergeChunks(chunks: MessageChunk[], maxCount: number): MessageChunk[] {
  if (chunks.length <= maxCount) return chunks;

  const result = chunks.slice();
  while (result.length > maxCount) {
    let minIdx = 0;
    let minLen = result[0]!.text.length + result[1]!.text.length + Number(result[1]!.startsNewParagraph);
    for (let i = 1; i < result.length - 1; i++) {
      const len = result[i]!.text.length + result[i + 1]!.text.length + Number(result[i + 1]!.startsNewParagraph);
      if (len < minLen) {
        minLen = len;
        minIdx = i;
      }
    }
    result[minIdx] = {
      text: result[minIdx]!.text + (result[minIdx + 1]!.startsNewParagraph ? " " : "") + result[minIdx + 1]!.text,
      startsNewParagraph: result[minIdx]!.startsNewParagraph,
    };
    result.splice(minIdx + 1, 1);
  }
  return result;
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

  let protectedText = text;
  let kaomojiMapping = new Map<string, string>();
  if (cfg.enableKaomojiProtection) {
    const result = protectKaomoji(text);
    protectedText = result.text;
    kaomojiMapping = result.mapping;
  }

  const maxLength = cfg.maxLength * 2;
  if (getWesternRatio(protectedText) < 0.1 && protectedText.length > maxLength) {
    return [getRandomDefaultReply()];
  }

  const paragraphSentences = splitParagraphs(protectedText).map(splitIntoSentences);
  if (paragraphSentences.flat().length > cfg.maxSentenceNum) {
    return cfg.enableOverflowReturnAll ? [protectedText] : [getRandomDefaultReply()];
  }

  const targetLength = Math.max(1, Math.floor(protectedText.length / cfg.maxSplitNum));
  let chunks = groupSentences(paragraphSentences, targetLength, maxLength);
  chunks = mergeChunks(chunks, cfg.maxSplitNum)
    .map((chunk) => ({ ...chunk, text: chunk.text.replace(TRAILING_PUNCTUATION, "") }))
    .filter((chunk) => Boolean(chunk.text));

  if (chunks.length === 0) return [protectedText];

  if (cfg.enableKaomojiProtection) {
    return recoverKaomoji(
      chunks.map((chunk) => chunk.text),
      kaomojiMapping,
    );
  }

  return chunks.map((chunk) => chunk.text);
}
