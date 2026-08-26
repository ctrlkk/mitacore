import { BrainCircuitIcon, FileText, HouseIcon, ImagesIcon, NetworkIcon, StickerIcon } from "lucide-react";
import { Link, useLocation } from "react-router";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

export function AppSidebar() {
  return (
    <Sidebar collapsible="icon">
      <AppSidebarContent />
    </Sidebar>
  );
}

export function AppSidebarContent() {
  const { isMobile, setOpenMobile } = useSidebar();
  const { pathname } = useLocation();

  function handleNavigation() {
    if (isMobile) {
      setOpenMobile(false);
    }
  }

  return (
    <>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem></SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>导航</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-2">
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={pathname === "/"}>
                  <Link to="/" onClick={handleNavigation}>
                    <HouseIcon />
                    <span>首页</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={pathname === "/models"}>
                  <Link to="/models" onClick={handleNavigation}>
                    <BrainCircuitIcon />
                    <span>模型配置</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={pathname === "/persona"}>
                  <Link to="/persona" onClick={handleNavigation}>
                    <FileText />
                    <span>人设编辑器</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={pathname === "/knowledge"}>
                  <Link to="/knowledge" onClick={handleNavigation}>
                    <NetworkIcon />
                    <span>知识图谱</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={pathname === "/media"}>
                  <Link to="/media" onClick={handleNavigation}>
                    <ImagesIcon />
                    <span>媒体缓存</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={pathname === "/stickers"}>
                  <Link to="/stickers" onClick={handleNavigation}>
                    <StickerIcon />
                    <span>贴纸管理</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </>
  );
}
