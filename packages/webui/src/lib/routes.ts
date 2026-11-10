export type BreadcrumbItem = {
  path: string;
  label: string;
};

export const appRoutes = [
  { path: "/", label: "渠道管理" },
  { path: "/channels/onebot", label: "OneBot" },
  { path: "/channels/weixin", label: "微信" },
  { path: "/channels/qqbot", label: "QQ Bot" },
  { path: "/models", label: "模型配置" },
  { path: "/settings", label: "消息循环" },
  { path: "/persona", label: "人设编辑器" },
  { path: "/history", label: "对话历史" },
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
