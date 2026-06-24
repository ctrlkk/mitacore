import { createAnthropic } from "@ai-sdk/anthropic";
import { env } from "node:process";

export const provider = createAnthropic({
  name: "new-api",
  apiKey: env.OPENAI_API_KEY!,
  baseURL: env.OPENAI_API_BASE!,
});
