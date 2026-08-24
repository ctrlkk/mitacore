import type { ReactNode } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";

type TestPageProps = {
  title: string;
  description: string;
  children?: ReactNode;
};

function TestPage({ title, description, children }: TestPageProps) {
  return (
    <section className="flex flex-1 flex-col gap-4 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

export function TestIndexPage() {
  return (
    <TestPage title="测试页" description="用于验证应用导航和页面布局。">
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline">
          <Link to="/tests/overview">查看概览</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/tests/scenes">进入场景</Link>
        </Button>
      </div>
    </TestPage>
  );
}

export function TestOverviewPage() {
  return <TestPage title="测试概览" description="展示测试页面的一级路由。" />;
}

export function TestScenesPage() {
  return (
    <TestPage title="场景测试" description="展示带有上级路径的测试页面。">
      <Button asChild variant="outline">
        <Link to="/tests/scenes/preview">打开预览</Link>
      </Button>
    </TestPage>
  );
}

export function TestPreviewPage() {
  return <TestPage title="场景预览" description="展示三级路由的面包屑。" />;
}
