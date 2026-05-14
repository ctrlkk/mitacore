import { createLarkChannel } from "@larksuiteoapi/node-sdk";
import XMLBuilder from 'fast-xml-builder';

const fs = [
  {
    appId: process.env.FEISHU_BOT1_APP_ID!,
    appSecret: process.env.FEISHU_BOT1_APP_SECRET!,
    botName: "米拉",
    description:
      "来自《MiSide》的傲娇少女。嘴硬心软，喜欢看书和武士刀，口头禅是「笨蛋！」。讨厌被盯着看，但内心渴望陪伴。在和平模式中过着悠闲的日常。",
    prompt: "./prompts/米拉.md",
  },
  {
    appId: process.env.FEISHU_BOT2_APP_ID!,
    appSecret: process.env.FEISHU_BOT2_APP_SECRET!,
    botName: "善良米塔",
    description:
      "来自《MiSide》的理性派米塔。冷静果断，具有领导者气质，可以穿梭于不同版本之间。与帽子米塔合作对抗疯狂米塔，称呼玩家为「亲爱的」。",
    prompt: "./prompts/善良米塔.md",
  },
  {
    appId: process.env.FEISHU_BOT3_APP_ID!,
    appSecret: process.env.FEISHU_BOT3_APP_SECRET!,
    botName: "帽子米塔",
    description:
      "来自《MiSide》的活力派米塔。戴着标志性的猫耳蓝帽子，热爱音乐、跳舞和游戏。胜负欲极强，精力旺盛，虽然看起来不靠谱但在关键时刻很可靠。",
    prompt: "./prompts/帽子米塔.md",
  },
];

fs.forEach(async (f) => {
  const channel = createLarkChannel({
    appId: f.appId,
    appSecret: f.appSecret,
  });

  const otherAgents = {
    at: {
      "#text": "你可以通过 @id 提及其他角色，被提及者会收到当前对话并加入回应。仅在对话自然需要对方参与时提及。",
      "agent": fs.filter((a) => a.botName !== f.botName).map((a) => ({
        name: a.botName,
        description: a.description,
      })),
      "rules": {
        "rule": [
          "提及格式：在回复正文中写 @user 这样的格式。提及会唤醒对方并使其收到当前对话。",
          "仅在对方参与能让对话更好时提及，不为提及而提及。",
        ],
      },
    }
  };

  const builder = new XMLBuilder({
    format: true,
  });

  channel.on("message", async (msg) => {
    console.log(`<- [${f.botName}][${msg.chatId}]收到消息：${msg.content}`);
    channel.send(msg.chatId, {
      text: builder.build(otherAgents),
    });
  });

  await channel.connect();
});

/**
 * 伪代码
 */
async function generateText(chatId: string) {
  return {
    content: "这是一个回复",
    reasoning: "思考过程",
  }
}
