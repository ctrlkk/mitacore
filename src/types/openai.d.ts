import "openai";

declare module "openai/resources/chat/completions" {
    interface ChatCompletionMessage {
        reasoning_content?: string;
    }
}
