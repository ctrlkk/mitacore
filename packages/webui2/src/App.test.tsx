import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

    expect(await screen.findByRole("heading", { name: "WebUI" })).toBeInTheDocument();
  });

  it("为未知路由显示 404，并可返回首页", async () => {
    renderApp("/unknown");

    expect(await screen.findByRole("heading", { name: "页面不存在" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "返回首页" }));

    expect(await screen.findByRole("heading", { name: "WebUI" })).toBeInTheDocument();
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

    fireEvent.click(within(drawer).getByRole("link", { name: "首页" }));

    expect(await screen.findByRole("heading", { name: "WebUI" })).toBeInTheDocument();
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
