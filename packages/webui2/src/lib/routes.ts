export type BreadcrumbItem = {
  path: string;
  label: string;
};

export const appRoutes = [
  { path: "/", label: "首页" },
  { path: "/models", label: "模型配置" },
  { path: "/persona", label: "人设编辑器" },
  { path: "/knowledge", label: "知识图谱" },
  { path: "/media", label: "媒体缓存" },
  { path: "/stickers", label: "贴纸管理" },
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
