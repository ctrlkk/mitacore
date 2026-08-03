# bilibili

B 站视频相关能力的 TypeScript 实现。本目录的代码**不是从零编写**，而是 [`vendor/bilibili-api`](../../vendor/bilibili-api)（仓库 [ctrlkk/bilibili-api](https://github.com/ctrlkk/bilibili-api.git)，Python 实现）的 TypeScript 翻译/移植。

## ⚠️ 重要：维护与排错指南

> **在添加新功能、修改现有逻辑或排查 B 站接口相关问题时，第一步应该是查阅 [`vendor/bilibili-api`](../../vendor/bilibili-api) 中的 Python 源码**，而不是依赖记忆或网络搜索。B 站接口（尤其是 WBI 签名、流地址、参数细节）经常改动，Python 仓库通常更及时跟进。

仓库地址：<https://github.com/ctrlkk/bilibili-api.git>

工作流建议：

1. **新增功能**：先在 Python 仓库找到对应模块/函数 → 理解其依赖的 B 站接口、参数、返回值 → 在 TS 侧翻译
2. **修改 bug / 接口失效**：先 diff Python 仓库的更新 → 把对应改动同步到 TS 实现
3. **排查未知问题**：在 Python 仓库中按路径定位，B 站接口细节往往有充分注释

## 与 Python 源码的对应关系

| TypeScript 文件 | Python 源文件 |
| --- | --- |
| `bvid.ts` | [`bilibili_api/utils/aid_bvid_transformer.py`](../../vendor/bilibili-api/bilibili_api/utils/aid_bvid_transformer.py) |
| `parse-link.ts` | [`bilibili_api/utils/parse_link.py`](../../vendor/bilibili-api/bilibili_api/utils/parse_link.py) |
| `wbi.ts` | [`bilibili_api/utils/network.py`](../../vendor/bilibili-api/bilibili_api/utils/network.py) 中 WBI 相关 |
| `api.ts` | [`bilibili_api/video.py`](../../vendor/bilibili-api/bilibili_api/video.py) 中 `get_video_info` / `get_download_url` |
| `download.ts` | 由 Python 仓库多个模块组合而来（`video.py` + `utils/network.py` 下载工具） |
| `index.ts` | — （本目录的对外导出） |

## 目录结构

| 文件 | 作用 |
| --- | --- |
| `index.ts` | 统一对外导出 |
| `bvid.ts` | BV 号 / AV 号互转算法 |
| `parse-link.ts` | 从用户输入中提取视频 ID |
| `wbi.ts` | WBI 签名（部分接口的请求鉴权） |
| `api.ts` | 视频信息 / 下载地址 API 封装 |
| `download.ts` | 一站式下载器（带 ffmpeg 合并） |

## 整体流程

```
用户输入（BV 号 / URL / 短链接）
        │
        ▼
  extractVideoId  ─── 短链接 ──→  resolveShortUrl
        │                          │
        └──────────────┬───────────┘
                       ▼
                  getVideoInfo          ← 拿到分 P、cid、标题等
                       │
                       ▼
                 getDownloadUrl          ← 拿到 DASH 音视频流地址
                       │
                       ▼
              downloadBilibiliVideo      ← 下载 + ffmpeg 合并
```

## 典型用法

```ts
import { extractVideoId, resolveShortUrl, getVideoInfo, downloadBilibiliVideo } from "bilibili";

// 1. 解析用户输入
const shortUrl = "https://b23.tv/xxxxx";
const realUrl = await resolveShortUrl(shortUrl);
const id = extractVideoId(realUrl!);
if (!id) throw new Error("无法识别视频 ID");

// 2. 获取视频信息
const info = await getVideoInfo(id.bvid);
console.log(info.title, info.pages);

// 3. 下载第一个分 P
const cid = info.pages[0].cid;
await downloadBilibiliVideo(id.bvid, cid, "./output.mp4", {
  cookie: process.env.BILIBILI_COOKIE,
  onProgress: (phase, pct) => console.log(`${phase}: ${pct}%`),
});
```

## 翻译时的注意事项

- Python 仓库默认基于 `aiohttp` / `httpx`，TS 实现统一使用原生 `fetch`
- Python 大量使用 dataclass / Pydantic，TS 侧使用 interface + 类型守卫
- Python 是异步库（基于 asyncio），TS 侧也是异步（基于 Promise / async-await）
- 部分 Python 模块使用装饰器做缓存，TS 侧改为模块级变量 + 显式 `reset*` 函数
- 原始仓库遵循 `GNU General Public License Version 3`

## 同步上游变更

当 Python 仓库更新时：

```bash
cd vendor/bilibili-api
git pull https://github.com/ctrlkk/bilibili-api.git main
```

然后对比本目录与 Python 源码的差异，把变更同步过来。
