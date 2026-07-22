import { logger } from "./logger";
import type { OneBotEventContext } from "./onebot/onebot-client";
import type { OneBotMessageEvent } from "./onebot/websocket-client";

async function handleBilibiliDownload(input: string, ctx: OneBotEventContext<OneBotMessageEvent>) {
  const { mkdir } = await import("node:fs/promises");
  const { dataPath } = await import("@/utils/path");
  const { aid2bvid } = await import("./bilibili/bvid");
  const { extractVideoId, resolveShortUrl } = await import("./bilibili/parse-link");
  const { getVideoInfo } = await import("./bilibili/api");
  const { downloadBilibiliVideo } = await import("./bilibili/download");

  let id = extractVideoId(input);

  if (!id) {
    const realUrl = await resolveShortUrl(input);
    if (realUrl) id = extractVideoId(realUrl);
  }

  if (!id) throw new Error("无法识别视频链接或 BV 号");

  const bvid = id.bvid || aid2bvid(id.aid);
  const info = await getVideoInfo(bvid);
  const page = info.pages[0];
  if (!page) throw new Error("视频没有可下载的分 P");
  const cid = page.cid;

  await mkdir(dataPath("videos"), { recursive: true });
  const outputPath = dataPath("videos", `${bvid}.mp4`);

  await downloadBilibiliVideo(bvid, cid, outputPath);
  // 使用环境中的 ffmpeg 提取首帧作为封面（dataurl 格式）
  let cover: string | undefined;
  const ffmpeg = Bun.which("ffmpeg");
  if (ffmpeg) {
    try {
      const proc = Bun.spawn(
        [ffmpeg, "-ss", "0", "-i", outputPath, "-vframes", "1", "-q:v", "2", "-f", "image2pipe", "-"],
        { stderr: "ignore" },
      );
      const buffer = await new Response(proc.stdout).arrayBuffer();
      const exitCode = await proc.exited;
      if (exitCode === 0 && buffer.byteLength > 0) {
        const base64 = Buffer.from(buffer).toString("base64");
        cover = `data:image/jpeg;base64,${base64}`;
      } else {
        logger.warn("封面提取失败");
      }
    } catch (error) {
      logger.warn({ error }, "封面提取异常");
    }
  }

  const videoUrl = `file:///${outputPath.replace(/\\/g, "/")}`;
  await ctx.reply([{ type: "video", data: { file: videoUrl, thumb: cover } }]);
}
