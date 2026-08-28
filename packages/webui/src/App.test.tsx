import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HashRouter } from "react-router";
import { ThemeProvider } from "@/components/ThemeProvider";
import { TooltipProvider } from "@/components/ui/tooltip";
import App from "./App.tsx";

vi.mock("@/components/PersonaEditor", () => ({
  PersonaEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="人设内容" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

function renderApp(path = "/") {
  window.location.hash = path;

  return render(
    <ThemeProvider attribute="class">
      <TooltipProvider>
        <HashRouter>
          <App />
        </HashRouter>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

function renderMobileApp(path = "/") {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 375 });

  return renderApp(path);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "/";
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1024 });
});

describe("App", () => {
  it("显示首页", async () => {
    renderApp();

    expect(await screen.findByRole("heading", { name: "渠道管理" })).toBeInTheDocument();
  });

  it("确认后重启服务", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/runtime/restart") {
        return Promise.resolve(new Response(JSON.stringify({ accepted: true }), { status: 202 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            napcat: { enabled: false },
            weixin: { enabled: false },
            qqbot: { enabled: false },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: "重启服务" }));
    expect(await screen.findByRole("heading", { name: "重启服务？" })).toBeInTheDocument();
    expect(screen.getByText("重启期间，正在处理的消息可能中断。")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认重启" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/runtime/restart", { method: "POST" });
    });
  });

  it("显示 OneBot 配置路由", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            napcat: {
              enabled: false,
              wake_keywords: [],
              groups: { mode: "blacklist", ids: [] },
              private_chats: { mode: "blacklist", ids: [] },
              group_members: { mode: "blacklist", ids: [] },
              admins: [],
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    );
    renderApp("/channels/onebot");

    expect(await screen.findByRole("heading", { name: "OneBot" })).toBeInTheDocument();
  });

  it("显示微信配置路由", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ weixin: { enabled: false } }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    renderApp("/channels/weixin");

    expect(await screen.findByRole("heading", { name: "微信" })).toBeInTheDocument();
  });

  it("显示 QQ Bot 配置路由", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ qqbot: { enabled: false, admins: [] } }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    renderApp("/channels/qqbot");

    expect(await screen.findByRole("heading", { name: "QQ Bot" })).toBeInTheDocument();
  });

  it("为未知路由显示 404，并可返回首页", async () => {
    renderApp("/unknown");

    expect(await screen.findByRole("heading", { name: "页面不存在" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "返回首页" }));

    expect(await screen.findByRole("heading", { name: "渠道管理" })).toBeInTheDocument();
  });

  it("显示人设编辑器路由", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ content: "你是一名友好的助手。" }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    renderApp("/persona");

    expect(await screen.findByRole("heading", { name: "人设编辑器" })).toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: "人设内容" })).toHaveValue("你是一名友好的助手。");
  });

  it("显示知识图谱路由", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            notes: [
              {
                path: "项目.md",
                title: "项目",
                folder: "",
                size: 128,
                updated_at: 0,
                links: ["计划.md"],
              },
              {
                path: "计划.md",
                title: "计划",
                folder: "",
                size: 64,
                updated_at: 0,
                links: [],
              },
            ],
            summary: { total: 2, links: 1 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    );
    renderApp("/knowledge");

    expect(await screen.findByRole("heading", { name: "知识图谱" })).toBeInTheDocument();
    expect(await screen.findByText("2 篇笔记")).toBeInTheDocument();
    expect(screen.getByText("1 个链接")).toBeInTheDocument();
  });

  it("显示媒体缓存并支持打开详情", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            media: [
              {
                filename: "forest.webp",
                kind: "image",
                path: "/images/forest.webp",
                description: "一片晨雾中的森林",
                size: 2048,
                updated_at: 0,
                url: "/api/media/forest.webp/content",
              },
            ],
            pagination: { page: 1, page_size: 24, total: 1, total_pages: 1 },
            summary: { total: 1, total_size: 2048 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    );
    renderApp("/media");

    expect(await screen.findByRole("heading", { name: "媒体缓存" })).toBeInTheDocument();
    expect(await screen.findByText("forest.webp")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看详情" }));

    expect(await screen.findByRole("textbox", { name: "媒体转述" })).toHaveValue("一片晨雾中的森林");
  });

  it("显示贴纸管理路由", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            stickers: [
              {
                name: "开心",
                filename: "开心.webp",
                description: "角色开心地比出胜利手势。",
                size: 2048,
                updated_at: 0,
                url: "/api/stickers/%E5%BC%80%E5%BF%83/content",
              },
            ],
            summary: { total: 1, limit: 30 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    );
    renderApp("/stickers");

    expect(await screen.findByRole("heading", { name: "贴纸管理" })).toBeInTheDocument();
    expect(await screen.findByText("[开心]")).toBeInTheDocument();
    expect(screen.getByText("角色开心地比出胜利手势。")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "预览贴纸 [开心]" }));

    expect(await screen.findByRole("dialog")).toHaveTextContent("[开心]");
  });

  it("可使用 AI 辅助填写贴纸表单", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/stickers") {
          return Promise.resolve(
            new Response(JSON.stringify({ stickers: [], summary: { total: 0, limit: 30 } }), {
              headers: { "content-type": "application/json" },
            }),
          );
        }
        if (url === "/api/config") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                providers: [{ models: [{ alias: "vision-model" }] }],
                models: { multimodal_image: "vision-model" },
              }),
              { headers: { "content-type": "application/json" } },
            ),
          );
        }
        if (url === "/api/stickers/suggestion") {
          return Promise.resolve(
            new Response(
              [
                JSON.stringify({ type: "status", message: "正在分析图片…" }),
                JSON.stringify({ type: "reasoning", delta: "识别到开心表情。" }),
                JSON.stringify({ type: "result", suggestion: { name: "开心", description: "表达开心和庆祝的场景。" } }),
              ].join("\n"),
            ),
          );
        }
        return Promise.reject(new Error(`意外请求：${url}`));
      }),
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:sticker-preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    renderApp("/stickers");

    fireEvent.click(await screen.findByRole("button", { name: "添加贴纸" }));
    fireEvent.change(screen.getByLabelText("贴纸图片"), {
      target: { files: [new File(["sticker"], "happy.png", { type: "image/png" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成建议" }));

    expect(await screen.findByDisplayValue("开心")).toBeInTheDocument();
    expect(screen.getByDisplayValue("表达开心和庆祝的场景。")).toBeInTheDocument();
    expect(screen.getByText("分析过程")).toBeInTheDocument();
  });

  it("移动端可打开抽屉并通过内容层关闭", async () => {
    renderMobileApp();

    fireEvent.click(await screen.findByRole("button", { name: "Toggle Sidebar" }));

    expect(await screen.findByRole("complementary", { name: "主导航" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭侧栏" }));

    expect(screen.queryByRole("complementary", { name: "主导航" })).not.toBeInTheDocument();
  });

  it("移动端导航后收起抽屉", async () => {
    renderMobileApp();

    fireEvent.click(await screen.findByRole("button", { name: "Toggle Sidebar" }));
    const drawer = await screen.findByRole("complementary", { name: "主导航" });

    fireEvent.click(within(drawer).getByRole("link", { name: "渠道管理" }));

    expect(await screen.findByRole("heading", { name: "渠道管理" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "主导航" })).not.toBeInTheDocument();
  });

  it("移动端按 Escape 收起抽屉", async () => {
    renderMobileApp();

    fireEvent.click(await screen.findByRole("button", { name: "Toggle Sidebar" }));
    await screen.findByRole("complementary", { name: "主导航" });

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("complementary", { name: "主导航" })).not.toBeInTheDocument();
  });
});
