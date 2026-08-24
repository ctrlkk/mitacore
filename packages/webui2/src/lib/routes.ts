export type BreadcrumbItem = {
  path: string;
  label: string;
};

export const appRoutes = [
  { path: "/", label: "首页" },
  { path: "/tests", label: "测试页" },
  { path: "/tests/overview", label: "概览" },
  { path: "/tests/scenes", label: "场景" },
  { path: "/tests/scenes/preview", label: "预览" },
] as const satisfies readonly BreadcrumbItem[];

export function getBreadcrumbItems(pathname: string): BreadcrumbItem[] {
  const currentRoute = appRoutes.find((route) => route.path === pathname);

  if (!currentRoute) {
    return [appRoutes[0], { path: pathname, label: "页面不存在" }];
  }

  return appRoutes.filter(
    (route) => route.path === "/" || pathname === route.path || pathname.startsWith(`${route.path}/`),
  );
}
