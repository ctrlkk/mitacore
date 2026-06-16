/**
 * 消息分割器
 * 移植自 message_splitter.py，将 LLM 输出的长文本分割为多条可发送的短消息。
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

function isAlnum(char: string): boolean {
  return /[a-zA-Z0-9]/.test(char);
}

function isEnglishLetter(char: string): boolean {
  return char.toLowerCase() >= 'a' && char.toLowerCase() <= 'z';
}

function getWesternRatio(paragraph: string): number {
  const chars = [...paragraph];
  const alnumChars = chars.filter(c => isAlnum(c));
  if (alnumChars.length === 0) return 0;
  return alnumChars.filter(c => isEnglishLetter(c)).length / alnumChars.length;
}

// ── 颜文字保护 ────────────────────────────────────────────────

function protectKaomoji(sentence: string): { text: string; mapping: Map<string, string> } {
  const pattern = /([(\[（【][^()\[\]（）【】]*?[^\u4e00-\u9fa5a-zA-Z0-9\s][^()\[\]（）【】]*?[)\]）】])|([▼▽・ᴥω･﹏^><≧≦￣｀´∀ヮДд︿﹀へ｡ﾟ╥╯╰︶︹•⁄]{2,15})/g;
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
  return sentences.map(s => {
    for (const [placeholder, kaomoji] of mapping) {
      s = s.replaceAll(placeholder, kaomoji);
    }
    return s;
  });
}

// ── 句子分割 ──────────────────────────────────────────────────

function splitIntoSentences(text: string): string[] {
  text = text.replace(/\n\s*\n+/g, '\n');
  text = text.replace(/\n\s*([，,。;\s])/g, '\n$1');
  text = text.replace(/([，,。;\s])\s*\n/g, '$1\n');

  const lenText = text.length;
  if (lenText < 3) {
    return Math.random() < 0.01 ? [...text] : [text];
  }

  // 引号追踪
  const quoteChars = new Set(['"', "'", '\u201c', '\u201d', '\u2018', '\u2019', '\u300c', '\u300d', '\u300e', '\u300f']);
  const insideQuote = new Array<boolean>(lenText).fill(false);
  let inQuote = false;
  let currentQuoteChar = '';
  for (let i = 0; i < lenText; i++) {
    const ch = text.charAt(i);
    if (quoteChars.has(ch)) {
      if (!inQuote) {
        inQuote = true;
        currentQuoteChar = ch;
      } else if (ch === currentQuoteChar || ((ch === '"' || ch === "'") && (currentQuoteChar === '"' || currentQuoteChar === "'"))) {
        inQuote = false;
        currentQuoteChar = '';
      }
      insideQuote[i] = false;
    } else {
      insideQuote[i] = inQuote;
    }
  }

  const separators = new Set(['，', ',', ' ', '。', ';', '\n']);
  const segments: Array<{ content: string; sep: string }> = [];
  let currentSegment = '';

  for (let i = 0; i < lenText; i++) {
    const char = text.charAt(i);
    if (separators.has(char)) {
      let canSplit = !insideQuote[i];

      if (canSplit && char !== '\n') {
        const prev = i > 0 ? text.charAt(i - 1) : '';
        const next = i < lenText - 1 ? text.charAt(i + 1) : '';
        if (prev === ':' || prev === '：') canSplit = false;
        if (next === ':' || next === '：') canSplit = false;
        if (canSplit && char === ' ' && i > 0 && i < lenText - 1) {
          if (prev === '-' || prev === '—' || next === '-' || next === '—') {
            canSplit = false;
          } else if (isAlnum(prev) && isAlnum(next)) {
            canSplit = false;
          }
        }
      }

      if (canSplit) {
        if (currentSegment) {
          segments.push({ content: currentSegment, sep: char });
        } else if (char === ' ' || char === '\n') {
          segments.push({ content: '', sep: char });
        }
        currentSegment = '';
      } else {
        currentSegment += char;
      }
    } else {
      currentSegment += char;
    }
  }

  if (currentSegment) {
    segments.push({ content: currentSegment, sep: '' });
  }

  const filtered = segments.filter(s => s.content || s.sep);
  if (filtered.length === 0) return text ? [text] : [];

  // 根据长度计算合并概率
  const splitStrength = lenText < 12 ? 0.2 : lenText < 32 ? 0.6 : 0.7;
  const mergeProbability = 1.0 - splitStrength;

  const merged: Array<{ content: string; sep: string }> = [];
  let idx = 0;
  while (idx < filtered.length) {
    const cur = filtered[idx]!;
    if (idx + 1 < filtered.length && cur.content && cur.sep !== '\n' && Math.random() < mergeProbability) {
      const next = filtered[idx + 1]!;
      if (next.content) {
        merged.push({ content: cur.content + cur.sep + next.content, sep: next.sep });
      } else {
        merged.push({ content: cur.content, sep: next.sep });
      }
      idx += 2;
    } else {
      merged.push(cur);
      idx++;
    }
  }

  return merged
    .map(s => s.content)
    .filter(s => s.trim())
    .map(s => s.replace(/[^\S\r\n]*[\r\n]+[^\S\r\n]*/g, ' ').trim());
}

// ── 合并 ──────────────────────────────────────────────────────

function mergeSentencesToMaxCount(sentences: string[], maxCount: number): string[] {
  if (sentences.length <= maxCount) return sentences;
  const total = sentences.length;
  const result: string[] = [];
  let start = 0;
  for (let groupIdx = 0; groupIdx < maxCount; groupIdx++) {
    const remaining = total - start;
    const remainingGroups = maxCount - groupIdx;
    const groupSize = Math.ceil(remaining / remainingGroups);
    result.push(sentences.slice(start, start + groupSize).join(''));
    start += groupSize;
  }
  return result;
}

// ── 主入口 ────────────────────────────────────────────────────

const DEFAULT_REPLIES = ['不知道哦', '不知道', '不晓得', '懒得说', '()'];

function getRandomDefaultReply(): string {
  return DEFAULT_REPLIES[Math.floor(Math.random() * DEFAULT_REPLIES.length)]!;
}

export function splitMessage(text: string, config: Partial<SplitterConfig> = {}): string[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enable) return [text];

  // 1. 保护颜文字
  let protectedText = text;
  let kaomojiMapping = new Map<string, string>();
  if (cfg.enableKaomojiProtection) {
    const result = protectKaomoji(text);
    protectedText = result.text;
    kaomojiMapping = result.mapping;
  }

  // 2. 去除括号包裹的辅助信息（含中文的括号内容）
  const bracketPattern = /[(\[（](?=.*[\u4e00-\u9fff]).*?[)\]）]/g;
  const cleanedText = protectedText.replace(bracketPattern, '');
  if (!cleanedText.trim()) return ['呃呃'];

  // 3. 中文文本长度检查
  const maxLength = cfg.maxLength * 2;
  if (getWesternRatio(cleanedText) < 0.1 && cleanedText.length > maxLength) {
    return [getRandomDefaultReply()];
  }

  // 4. 分割句子
  let sentences = cfg.enable ? splitIntoSentences(cleanedText) : [cleanedText];

  // 5. 句子数量检查
  if (sentences.length > cfg.maxSentenceNum) {
    sentences = cfg.enableOverflowReturnAll ? [cleanedText] : [getRandomDefaultReply()];
  }

  // 6. 合并到最大条数
  sentences = mergeSentencesToMaxCount(sentences, cfg.maxSplitNum);

  // 7. 恢复颜文字
  if (cfg.enableKaomojiProtection) {
    sentences = recoverKaomoji(sentences, kaomojiMapping);
  }

  return sentences;
}
