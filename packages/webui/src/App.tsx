import { Check, Image, LoaderCircle, Save, Settings2 } from "lucide-react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { useConfig } from "./hooks/useConfig";
import { ImagesPage } from "./pages/ImagesPage";
import { ModelsPage } from "./pages/ModelsPage";
import { PlatformPage } from "./pages/PlatformPage";

const pageMeta = {
  platform: ["PLATFORM", "用户配置平台"],
  models: ["MODELS", "模型配置"],
  images: ["MEDIA LIBRARY", "图片缓存"],
} as const;

function Page({ page }: { page: keyof typeof pageMeta }) {
  const { config, setConfig, loading, error, saveState, saveConfig, updateProvider, reloadConfig } = useConfig();
  const [eyebrow, title] = pageMeta[page];
  if (loading)
    return (
      <main className="loading-page">
        <LoaderCircle className="spin" />
        正在加载控制台…
      </main>
    );
  const content =
    page === "platform" ? (
      <PlatformPage config={config} setConfig={setConfig} reloadConfig={reloadConfig} />
    ) : page === "models" ? (
      <ModelsPage config={config} setConfig={setConfig} updateProvider={updateProvider} />
    ) : (
      <ImagesPage />
    );
  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <span>MC</span>
          <div>
            <strong>Mita Core</strong>
            <small>控制台</small>
          </div>
        </div>
        <nav>
          <NavLink to="/platform" className={({ isActive }) => (isActive ? "active" : "")}>
            <Settings2 size={16} />
            用户配置平台
          </NavLink>
          <NavLink to="/models" className={({ isActive }) => (isActive ? "active" : "")}>
            <Settings2 size={16} />
            模型
          </NavLink>
          <NavLink to="/images" className={({ isActive }) => (isActive ? "active" : "")}>
            <Image size={16} />
            图片缓存
          </NavLink>
        </nav>
        <p>本地控制台，仅服务于当前机器。</p>
      </aside>
      <main>
        <header>
          <div>
            <p className="eyebrow">{eyebrow}</p>
            <h1>{title}</h1>
          </div>
          {page !== "images" && (
            <button className="button" disabled={saveState === "saving"} onClick={saveConfig}>
              {saveState === "saving" ? (
                <LoaderCircle className="spin" size={17} />
              ) : saveState === "saved" ? (
                <Check size={17} />
              ) : (
                <Save size={17} />
              )}
              {saveState === "saved" ? "已保存" : saveState === "saving" ? "正在保存" : "保存配置"}
            </button>
          )}
        </header>
        {error && <p className="notice error">{error}</p>}
        {content}
      </main>
    </div>
  );
}
export default function App() {
  return (
    <Routes>
      <Route path="/platform" element={<Page page="platform" />} />
      <Route path="/models" element={<Page page="models" />} />
      <Route path="/images" element={<Page page="images" />} />
      <Route path="*" element={<Navigate to="/platform" replace />} />
    </Routes>
  );
}
