import {
  BookOpen,
  Check,
  FilePenLine,
  Image,
  LoaderCircle,
  RefreshCw,
  Save,
  Settings2,
  SlidersHorizontal,
  Sticker,
} from "lucide-react";
import { lazy, Suspense } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { useConfig } from "./hooks/useConfig";
import { BatchStickersPage } from "./pages/BatchStickersPage";
import { ImagesPage } from "./pages/ImagesPage";
import { ModePage } from "./pages/ModePage";
import { ModelsPage } from "./pages/ModelsPage";
import { PlatformPage } from "./pages/PlatformPage";
import { StickersPage } from "./pages/StickersPage";

const PersonaPage = lazy(() => import("./pages/PersonaPage").then((module) => ({ default: module.PersonaPage })));
const KnowledgePage = lazy(() => import("./pages/KnowledgePage").then((module) => ({ default: module.KnowledgePage })));

const pageMeta = {
  platform: ["PLATFORM", "用户配置平台"],
  mode: ["MODE", "运行模式"],
  models: ["MODELS", "模型配置"],
  persona: ["PERSONA", "人设编辑器"],
  knowledge: ["KNOWLEDGE BASE", "知识库工作台"],
  images: ["MEDIA LIBRARY", "图片缓存"],
  stickers: ["STICKER LIBRARY", "贴纸管理"],
  stickers_batch: ["STICKER BATCH", "批量创建贴纸"],
} as const;

function Page({ page }: { page: keyof typeof pageMeta }) {
  const {
    config,
    setConfig,
    loading,
    error,
    saveState,
    saveConfig,
    restartState,
    restart,
    updateProvider,
    reloadConfig,
  } = useConfig();
  const [eyebrow, title] = pageMeta[page];
  const usesConfig = !["images", "persona", "knowledge"].includes(page);
  const isConfigPage = !["images", "stickers", "persona", "knowledge"].includes(page);
  if (loading && usesConfig)
    return (
      <main className="flex min-h-screen items-center justify-center gap-2 text-sm text-muted">
        <LoaderCircle className="animate-spin" />
        正在加载控制台…
      </main>
    );
  const content =
    page === "platform" ? (
      <PlatformPage config={config} setConfig={setConfig} reloadConfig={reloadConfig} />
    ) : page === "mode" ? (
      <ModePage config={config} setConfig={setConfig} />
    ) : page === "models" ? (
      <ModelsPage config={config} setConfig={setConfig} updateProvider={updateProvider} />
    ) : page === "images" ? (
      <ImagesPage />
    ) : page === "persona" ? (
      <PersonaPage />
    ) : page === "knowledge" ? (
      <KnowledgePage />
    ) : page === "stickers_batch" ? (
      <BatchStickersPage config={config} />
    ) : (
      <StickersPage config={config} />
    );
  return (
    <div className="grid min-h-screen grid-cols-[236px_minmax(0,1fr)] max-[820px]:block">
      <aside className="sticky top-0 flex h-screen flex-col self-start bg-ink px-3.5 py-6 text-[#d5dce4] max-[820px]:static max-[820px]:h-auto max-[820px]:px-3.5 max-[820px]:py-3">
        <div className="flex items-center gap-2.75 px-2.5 pb-7.75 pt-1 max-[820px]:px-2 max-[820px]:pb-3 max-[820px]:pt-0">
          <span className="grid h-8.5 w-8.5 place-items-center rounded-2.5 bg-[#75e0c1] text-xs font-800 text-[#0f2131]">
            MC
          </span>
          <div>
            <strong className="block text-sm text-white">Mita Core</strong>
            <small className="mt-0.5 block text-[11px] text-[#8e9daa]">控制台</small>
          </div>
        </div>
        <nav className="grid gap-1 max-[820px]:flex max-[820px]:flex-wrap">
          <NavLink
            to="/platform"
            className={({ isActive }) =>
              `flex w-full items-center gap-2.25 rounded-lg px-3 py-2.75 text-left text-sm text-inherit hover:bg-[#263544] hover:text-white ${isActive ? "bg-[#263544] text-white" : ""}`
            }
          >
            <Settings2 size={16} />
            用户配置平台
          </NavLink>
          <NavLink
            to="/mode"
            className={({ isActive }) =>
              `flex w-full items-center gap-2.25 rounded-lg px-3 py-2.75 text-left text-sm text-inherit hover:bg-[#263544] hover:text-white ${isActive ? "bg-[#263544] text-white" : ""}`
            }
          >
            <SlidersHorizontal size={16} />
            运行模式
          </NavLink>
          <NavLink
            to="/models"
            className={({ isActive }) =>
              `flex w-full items-center gap-2.25 rounded-lg px-3 py-2.75 text-left text-sm text-inherit hover:bg-[#263544] hover:text-white ${isActive ? "bg-[#263544] text-white" : ""}`
            }
          >
            <Settings2 size={16} />
            模型
          </NavLink>
          <NavLink
            to="/persona"
            className={({ isActive }) =>
              `flex w-full items-center gap-2.25 rounded-lg px-3 py-2.75 text-left text-sm text-inherit hover:bg-[#263544] hover:text-white ${isActive ? "bg-[#263544] text-white" : ""}`
            }
          >
            <FilePenLine size={16} />
            人设编辑器
          </NavLink>
          <NavLink
            to="/knowledge"
            className={({ isActive }) =>
              `flex w-full items-center gap-2.25 rounded-lg px-3 py-2.75 text-left text-sm text-inherit hover:bg-[#263544] hover:text-white ${isActive ? "bg-[#263544] text-white" : ""}`
            }
          >
            <BookOpen size={16} />
            知识库
          </NavLink>
          <NavLink
            to="/images"
            className={({ isActive }) =>
              `flex w-full items-center gap-2.25 rounded-lg px-3 py-2.75 text-left text-sm text-inherit hover:bg-[#263544] hover:text-white ${isActive ? "bg-[#263544] text-white" : ""}`
            }
          >
            <Image size={16} />
            图片缓存
          </NavLink>
          <NavLink
            to="/stickers"
            className={({ isActive }) =>
              `flex w-full items-center gap-2.25 rounded-lg px-3 py-2.75 text-left text-sm text-inherit hover:bg-[#263544] hover:text-white ${isActive ? "bg-[#263544] text-white" : ""}`
            }
          >
            <Sticker size={16} />
            贴纸管理
          </NavLink>
        </nav>
        <p className="mt-auto mx-2.5 text-[11px] leading-[1.6] text-[#8e9daa] max-[820px]:hidden">
          本地控制台，仅服务于当前机器。
        </p>
      </aside>
      <main className="min-w-0">
        <header className="flex min-h-24 items-center justify-between gap-6 bb-ui bg-white px-[clamp(20px,5vw,72px)] py-5 max-[820px]:min-h-19 max-[480px]:p-4">
          <div>
            <p className="mb-1.25 font-mono text-[10px] font-500 tracking-[0.12em] text-muted">{eyebrow}</p>
            <h1 className="font-mono text-[22px] tracking-[-0.03em] max-[480px]:text-[19px]">{title}</h1>
          </div>
          {isConfigPage && (
            <div className="flex flex-wrap justify-end gap-2">
              <button
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#e9eff2] px-3.5 py-2.5 text-sm font-700 text-[#294051] hover:bg-[#dce5e9] disabled:cursor-wait disabled:opacity-65 max-[480px]:px-2.75 max-[480px]:py-2.25"
                disabled={restartState === "restarting"}
                onClick={restart}
              >
                {restartState === "restarting" ? (
                  <LoaderCircle className="animate-spin" size={17} />
                ) : (
                  <RefreshCw size={17} />
                )}
                {restartState === "restarting" ? "正在重启" : "重启服务（仅桌面版）"}
              </button>
              <button
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand px-3.5 py-2.5 text-sm font-700 text-white hover:bg-brand-dark disabled:cursor-wait disabled:opacity-65 max-[480px]:px-2.75 max-[480px]:py-2.25"
                disabled={saveState === "saving" || restartState === "restarting"}
                onClick={saveConfig}
              >
                {saveState === "saving" ? (
                  <LoaderCircle className="animate-spin" size={17} />
                ) : saveState === "saved" ? (
                  <Check size={17} />
                ) : (
                  <Save size={17} />
                )}
                {saveState === "saved" ? "已保存" : saveState === "saving" ? "正在保存" : "保存配置"}
              </button>
            </div>
          )}
        </header>
        {usesConfig && error && (
          <p className="mx-[clamp(20px,5vw,72px)] mt-5 rounded-lg bg-[#fff0f0] px-3 py-2.5 text-xs leading-[1.5] text-[#922e2e]">
            {error}
          </p>
        )}
        {isConfigPage && saveState === "saved" && (
          <p className="mx-[clamp(20px,5vw,72px)] mt-5 rounded-lg bg-[#edf7f2] px-3 py-2.5 text-xs leading-[1.5] text-[#416050]">
            配置已保存，重启服务后生效。重启功能仅支持桌面版。
          </p>
        )}
        <Suspense
          fallback={
            <p className="flex min-h-70 items-center justify-center gap-2 text-sm text-muted">
              <LoaderCircle className="animate-spin" size={18} />
              正在加载工作台…
            </p>
          }
        >
          {content}
        </Suspense>
      </main>
    </div>
  );
}
export default function App() {
  return (
    <Routes>
      <Route path="/platform" element={<Page page="platform" />} />
      <Route path="/mode" element={<Page page="mode" />} />
      <Route path="/models" element={<Page page="models" />} />
      <Route path="/persona" element={<Page page="persona" />} />
      <Route path="/knowledge" element={<Page page="knowledge" />} />
      <Route path="/images" element={<Page page="images" />} />
      <Route path="/stickers" element={<Page page="stickers" />} />
      <Route path="/stickers/batch" element={<Page page="stickers_batch" />} />
      <Route path="*" element={<Navigate to="/platform" replace />} />
    </Routes>
  );
}
