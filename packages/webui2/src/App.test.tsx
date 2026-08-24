import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HashRouter } from "react-router";
import { ThemeProvider } from "@/components/ThemeProvider";
import { TooltipProvider } from "@/components/ui/tooltip";
import App from "./App.tsx";

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
  window.location.hash = "/";
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1024 });
});

describe("App", () => {
  it("显示首页", () => {
    renderApp();

    expect(screen.getByRole("heading", { name: "WebUI" })).toBeInTheDocument();
  });

  it("为未知路由显示 404，并可返回首页", () => {
    renderApp("/unknown");

    expect(screen.getByRole("heading", { name: "页面不存在" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "返回首页" }));

    expect(screen.getByRole("heading", { name: "WebUI" })).toBeInTheDocument();
  });

  it("为三级测试页显示面包屑，并能导航到上级页面", () => {
    renderApp("/tests/scenes/preview");

    expect(screen.getByRole("heading", { name: "场景预览" })).toBeInTheDocument();

    const breadcrumb = screen.getByRole("navigation", { name: "面包屑" });
    expect(within(breadcrumb).getByRole("link", { name: "首页" })).toBeInTheDocument();
    expect(within(breadcrumb).getByRole("link", { name: "测试页" })).toBeInTheDocument();
    expect(within(breadcrumb).getByRole("link", { name: "场景" })).toBeInTheDocument();
    expect(within(breadcrumb).getByText("预览")).toHaveAttribute("aria-current", "page");

    fireEvent.pointerDown(within(breadcrumb).getByRole("button", { name: "展开路径" }), {
      button: 0,
      ctrlKey: false,
    });

    const breadcrumbMenu = screen.getByRole("menu");
    expect(within(breadcrumbMenu).getByRole("menuitem", { name: "测试页" })).toBeInTheDocument();
    expect(within(breadcrumbMenu).getByRole("menuitem", { name: "场景" })).toBeInTheDocument();

    fireEvent.click(within(breadcrumbMenu).getByRole("menuitem", { name: "场景" }));

    expect(screen.getByRole("heading", { name: "场景测试" })).toBeInTheDocument();
  });

  it("移动端可打开抽屉并通过内容层关闭", async () => {
    renderMobileApp();

    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));

    expect(await screen.findByRole("complementary", { name: "主导航" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭侧栏" }));

    expect(screen.queryByRole("complementary", { name: "主导航" })).not.toBeInTheDocument();
  });

  it("移动端导航后收起抽屉", async () => {
    renderMobileApp();

    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    const drawer = await screen.findByRole("complementary", { name: "主导航" });

    fireEvent.click(within(drawer).getByRole("link", { name: "测试页" }));

    expect(screen.getByRole("heading", { name: "测试页" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "主导航" })).not.toBeInTheDocument();
  });

  it("移动端按 Escape 收起抽屉", async () => {
    renderMobileApp();

    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    await screen.findByRole("complementary", { name: "主导航" });

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("complementary", { name: "主导航" })).not.toBeInTheDocument();
  });
});
