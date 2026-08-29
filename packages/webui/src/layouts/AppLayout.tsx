import { Fragment, Suspense, useEffect, useState } from "react";
import { LoaderCircleIcon, MoreHorizontalIcon, RefreshCwIcon } from "lucide-react";
import { Link, Outlet, useLocation } from "react-router";
import { toast } from "sonner";
import { AppSidebar, AppSidebarContent } from "@/components/AppSidebar";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { getBreadcrumbItems } from "@/lib/routes";
import { usePushDrawer } from "@/hooks/use-push-drawer";

const MOBILE_DRAWER_WIDTH = 288;
const MOBILE_DRAWER_VIEWPORT_RATIO = 0.8;
function getMobileDrawerWidth() {
  return Math.min(MOBILE_DRAWER_WIDTH, Math.round(window.innerWidth * MOBILE_DRAWER_VIEWPORT_RATIO));
}

export function AppLayout() {
  return (
    <SidebarProvider>
      <AppShell />
    </SidebarProvider>
  );
}

function AppShell() {
  const { isMobile } = useSidebar();

  if (isMobile) {
    return <MobileAppShell />;
  }

  return <DesktopAppShell />;
}

function DesktopAppShell() {
  return (
    <>
      <AppSidebar />
      <SidebarInset>
        <AppContent />
      </SidebarInset>
    </>
  );
}

function MobileAppShell() {
  const { openMobile, setOpenMobile } = useSidebar();
  const [drawerWidth, setDrawerWidth] = useState(getMobileDrawerWidth);
  const { close, contentRef, drawerHandlers, scrimRef } = usePushDrawer({
    drawerWidth,
    open: openMobile,
    onOpenChange: setOpenMobile,
  });

  useEffect(() => {
    const updateDrawerWidth = () => setDrawerWidth(getMobileDrawerWidth());

    window.addEventListener("resize", updateDrawerWidth);
    return () => window.removeEventListener("resize", updateDrawerWidth);
  }, []);

  useEffect(() => {
    if (!openMobile) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenMobile(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [openMobile, setOpenMobile]);

  return (
    <div className="relative min-h-svh w-full overflow-hidden bg-sidebar">
      <aside
        aria-hidden={!openMobile}
        aria-label="主导航"
        className="fixed inset-y-0 left-0 z-0 flex flex-col bg-sidebar text-sidebar-foreground"
        inert={!openMobile}
        style={{ width: drawerWidth }}
      >
        <AppSidebarContent />
      </aside>
      <div
        ref={contentRef}
        className="relative z-10 flex min-h-svh w-full flex-1 flex-col bg-background touch-pan-y will-change-transform"
        {...drawerHandlers}
      >
        <div inert={openMobile} className="flex min-h-svh flex-1 flex-col">
          <AppContent />
        </div>
        <button
          ref={scrimRef}
          type="button"
          aria-label="关闭侧栏"
          className={cn(
            "absolute inset-0 z-10 bg-foreground opacity-0",
            openMobile ? "pointer-events-auto" : "pointer-events-none",
          )}
          onClick={close}
        />
      </div>
    </div>
  );
}

function AppContent() {
  const { pathname } = useLocation();
  const breadcrumbItems = getBreadcrumbItems(pathname);
  const shouldCollapseBreadcrumb = breadcrumbItems.length > 3;
  const [isRestartDialogOpen, setIsRestartDialogOpen] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);

  async function restartService() {
    if (isRestarting) return;

    setIsRestarting(true);
    try {
      const response = await fetch("/api/runtime/restart", { method: "POST" });
      const data = await response.json().catch(() => undefined);
      if (!response.ok) {
        const message =
          data &&
          typeof data === "object" &&
          "error" in data &&
          data.error &&
          typeof data.error === "object" &&
          "message" in data.error &&
          typeof data.error.message === "string"
            ? data.error.message
            : "重启服务失败";
        throw new Error(message);
      }

      setIsRestartDialogOpen(false);
      toast.success("服务正在重启");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重启服务失败");
    } finally {
      setIsRestarting(false);
    }
  }

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mr-2 h-4 data-vertical:self-center" />
        <Breadcrumb aria-label="面包屑" className="min-w-0">
          <BreadcrumbList className="flex-nowrap overflow-hidden">
            {breadcrumbItems.map((item, index) => {
              const isCurrentPage = index === breadcrumbItems.length - 1;
              const isCollapsedItem = shouldCollapseBreadcrumb && index > 0 && !isCurrentPage;

              return (
                <Fragment key={item.path}>
                  {index > 0 ? (
                    <BreadcrumbSeparator className={shouldCollapseBreadcrumb ? "hidden sm:block" : undefined} />
                  ) : null}
                  {shouldCollapseBreadcrumb && index === 1 ? (
                    <>
                      <BreadcrumbSeparator className="sm:hidden" />
                      <BreadcrumbItem className="sm:hidden">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-xs" aria-label="展开路径">
                              <MoreHorizontalIcon data-icon="inline-start" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent>
                            {breadcrumbItems.slice(1, -1).map((collapsedItem) => (
                              <DropdownMenuItem key={collapsedItem.path} asChild>
                                <Link to={collapsedItem.path}>{collapsedItem.label}</Link>
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </BreadcrumbItem>
                      <BreadcrumbSeparator className="sm:hidden" />
                    </>
                  ) : null}
                  <BreadcrumbItem className={isCollapsedItem ? "hidden sm:flex" : "flex min-w-0"}>
                    {isCurrentPage ? (
                      <BreadcrumbPage className="truncate">{item.label}</BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink asChild className="truncate">
                        <Link to={item.path}>{item.label}</Link>
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                </Fragment>
              );
            })}
          </BreadcrumbList>
        </Breadcrumb>
        <div className="ml-auto flex items-center gap-1">
          <AlertDialog
            open={isRestartDialogOpen}
            onOpenChange={(open) => {
              if (!isRestarting) setIsRestartDialogOpen(open);
            }}
          >
            <AlertDialogTrigger asChild>
              <Button
                aria-label="重启服务"
                variant="ghost"
                size="sm"
                className="w-7 px-0 sm:w-auto sm:px-2.5"
                disabled={isRestarting}
              >
                {isRestarting ? (
                  <LoaderCircleIcon className="animate-spin" />
                ) : (
                  <RefreshCwIcon />
                )}
                <span className="hidden sm:inline">{isRestarting ? "正在重启" : "重启服务"}</span>
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>重启服务？</AlertDialogTitle>
                <AlertDialogDescription>重启期间，正在处理的消息可能中断。</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={isRestarting}>取消</AlertDialogCancel>
                <Button type="button" disabled={isRestarting} onClick={() => void restartService()}>
                  {isRestarting ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : null}
                  {isRestarting ? "正在重启" : "确认重启"}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <ThemeToggle />
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        <Suspense
          fallback={
            <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">正在加载页面</div>
          }
        >
          <Outlet />
        </Suspense>
      </main>
    </>
  );
}
