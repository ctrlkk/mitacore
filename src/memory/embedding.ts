// 纯文本输入
interface TextInput {
  type: "text";
  text: string;
}

// 图片输入 - 注意格式与 Chat API 不同
interface ImageInput {
  type: "image";
  image: string; // 图片 URL 或 base64 字符串
}

// 多模态输入项
type VLInputItem = TextInput | ImageInput;

// 兼容纯文本和多模态的输入类型
type EmbeddingInput = string | VLInputItem[];

// API 响应结构
interface EmbeddingResponse {
  object: "list";
  data: Array<{
    object: "embedding";
    index: number;
    embedding: number[];
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

const API_URL = "https://api.siliconflow.cn/v1/embeddings";
const API_KEY = "sk-uruoqbrvpfsndlqfznoffifpfrqcdxreqpdqfwwixkpjiewz";

/**
 * 获取嵌入向量 - 支持纯文本和多模态（图文）
 * @param input 可以是纯文本字符串，也可以是多模态数组
 * @returns 向量数组
 */
async function getEmbedding(input: EmbeddingInput): Promise<number[]> {
  try {
    // 如果输入是字符串，自动包装为文本格式
    const formattedInput: VLInputItem[] = typeof input === "string" ? [{ type: "text", text: input }] : input;

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: "Qwen/Qwen3-VL-Embedding-8B",
        input: formattedInput,
        // 可选：指定输出维度（仅支持 Qwen3 系列）
        // dimensions: 1024,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API 请求失败: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as EmbeddingResponse;

    if (data.data && data.data.length > 0 && data.data[0]!.embedding) {
      return data.data[0]!.embedding;
    } else {
      throw new Error("API 返回数据格式异常：未找到 embedding 数据");
    }
  } catch (error) {
    console.error("获取 Embedding 失败:", error);
    throw error;
  }
}

/**
 * 计算两个向量的余弦相似度
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) throw new Error("向量维度不一致");

  let dotProduct = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i]! * vecB[i]!;
    normA += vecA[i]! * vecA[i]!;
    normB += vecB[i]! * vecB[i]!;
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
