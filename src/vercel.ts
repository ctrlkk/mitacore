import { streamText } from 'ai';

const { textStream, reasoning } = streamText({
  model: 'gpt-3.5-turbo',
  messages: [
    {
      role: 'user',
      content: '你好',
    },
  ],
});

for await (const textPart of textStream) {
  console.log(textPart);
}