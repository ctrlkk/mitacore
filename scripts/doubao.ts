import { readFile } from "node:fs/promises";

const BASE_URL = "https://www.doubao.com";
const COOKIE = (await readFile("./scripts/doubao_cookie.txt", "utf-8")).trim();
const BOT_ID = "7338286299411103781";
const FP = "verify_mpnnxq4v_XVKi1FOA_Rp9b_4EIY_8Uy9_yjIPBQrSQgkK";

/**
 * 固定参数
 * @returns 查询字符串
 * */
function buildQuery(): string {
  const params = new URLSearchParams({
    aid: "497858",
    device_id: "7644449457954162203",
    device_platform: "web",
    fp: FP,
    language: "zh",
    pc_version: "3.21.3",
    pkg_type: "release_version",
    real_aid: "497858",
    region: "CN",
    samantha_web: "1",
    sys_region: "CN",
    tea_uuid: "7644449438509942312",
    "use-olympus-account": "1",
    version_code: "20800",
    web_id: "7644449438509942312",
    web_platform: "browser",
    web_tab_id: crypto.randomUUID(),
  });
  return params.toString();
}

/**
 * 请求体
 * @param text 消息内容
 * @returns 请求体
 */
function buildPayload(text: string) {
  return {
    client_meta: {
      local_conversation_id: `local_${Date.now()}`,
      conversation_id: "",
      bot_id: BOT_ID,
      last_section_id: "",
      last_message_index: null,
    },
    messages: [
      {
        local_message_id: crypto.randomUUID(),
        content_block: [
          {
            block_type: 10000,
            content: {
              text_block: { text, icon_url: "", icon_url_dark: "", summary: "" },
              pc_event_block: "",
            },
            block_id: crypto.randomUUID(),
            parent_id: "",
            meta_info: [],
            append_fields: [],
          },
        ],
        message_status: 0,
      },
    ],
    option: {
      send_message_scene: "",
      create_time_ms: Date.now(),
      collect_id: "",
      is_audio: false,
      answer_with_suggest: false,
      tts_switch: false,
      need_deep_think: 0,
      click_clear_context: false,
      from_suggest: false,
      is_regen: false,
      is_replace: false,
      is_from_click_option: false,
      disable_sse_cache: false,
      select_text_action: "",
      is_select_text: false,
      resend_for_regen: false,
      scene_type: 0,
      unique_key: crypto.randomUUID(),
      start_seq: 0,
      need_create_conversation: true,
      conversation_init_option: { need_ack_conversation: true },
      regen_query_id: [],
      edit_query_id: [],
      regen_instruction: "",
      no_replace_for_regen: false,
      message_from: 0,
      shared_app_name: "",
      shared_app_id: "",
      sse_recv_event_options: { support_chunk_delta: true },
      is_ai_playground: false,
      is_old_user: true,
      recovery_option: {
        is_recovery: false,
        req_create_time_sec: Math.floor(Date.now() / 1000),
        append_sse_event_scene: 0,
      },
      message_storage_type: 0,
    },
    ext: {
      fp: FP,
      sub_conv_firstmet_type: "1",
      collection_id: "",
      conversation_init_option: '{"need_ack_conversation":true}',
      commerce_credit_config_enable: "0",
      use_deep_think: "0",
    },
  };
}

/**
 * SSE 流解析
 * @param body 响应体
 * @returns 解析后的事件流
 */
async function* readSSE(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "{}") continue;
        yield JSON.parse(data);
      }
    }
  }
}

/**
 * 文本提取
 * @param ev 事件
 * @returns 文本内容
 */
function extractText(ev: Record<string, unknown>): string {
  let text = "";
  for (const op of (ev.patch_op as Array<any>) || []) {
    const content = op.patch_value.content as string | undefined;
    if (content) {
      try {
        const c = JSON.parse(content);
        if (c.text) text += c.text;
      } catch {}
    }
  }
  if (ev.end_type === 1) {
    const brief = (ev.msg_finish_attr as Record<string, unknown>)?.brief as string;
    if (brief) text = brief;
  }
  return text;
}

/**
 * 发送请求
 * @param text 消息内容
 * @returns 聊天结果
 */
async function chat(text: string) {
  const res = await fetch(`${BASE_URL}/chat/completion?${buildQuery()}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: COOKIE,
    },
    body: JSON.stringify(buildPayload(text)),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  let result = "";
  for await (const ev of readSSE(res.body!)) {
    if (ev.error_code) {
      throw new Error(`API 错误 [${ev.error_code}]: ${ev.error_msg} — ${JSON.stringify(ev.extra)}`);
    }
    result += extractText(ev);
  }
  return result;
}
