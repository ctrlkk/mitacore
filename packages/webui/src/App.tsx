import { lazy, type ComponentType } from "react";
import { Route, Routes } from "react-router";
import { AppLayout } from "./layouts/AppLayout.tsx";

function lazyPage(load: () => Promise<ComponentType>) {
  return lazy(async () => ({ default: await load() }));
}

const HomePage = lazyPage(async () => (await import("./pages/HomePage.tsx")).HomePage);
const OneBotChannelPage = lazyPage(async () => (await import("./pages/OneBotChannelPage.tsx")).OneBotChannelPage);
const WeixinChannelPage = lazyPage(async () => (await import("./pages/WeixinChannelPage.tsx")).WeixinChannelPage);
const QQBotChannelPage = lazyPage(async () => (await import("./pages/QQBotChannelPage.tsx")).QQBotChannelPage);
const ModelConfigPage = lazyPage(async () => (await import("./pages/ModelConfigPage.tsx")).ModelConfigPage);
const RuntimeSettingsPage = lazyPage(async () => (await import("./pages/RuntimeSettingsPage.tsx")).RuntimeSettingsPage);
const PersonaPage = lazyPage(async () => (await import("./pages/PersonaPage.tsx")).PersonaPage);
const KnowledgeGraphPage = lazyPage(async () => (await import("./pages/KnowledgeGraphPage.tsx")).KnowledgeGraphPage);
const MediaCachePage = lazyPage(async () => (await import("./pages/MediaCachePage.tsx")).MediaCachePage);
const StickersPage = lazyPage(async () => (await import("./pages/StickersPage.tsx")).StickersPage);
const NotFoundPage = lazyPage(async () => (await import("./pages/NotFoundPage.tsx")).NotFoundPage);

function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<HomePage />} />
        <Route path="channels/onebot" element={<OneBotChannelPage />} />
        <Route path="channels/weixin" element={<WeixinChannelPage />} />
        <Route path="channels/qqbot" element={<QQBotChannelPage />} />
        <Route path="models" element={<ModelConfigPage />} />
        <Route path="settings" element={<RuntimeSettingsPage />} />
        <Route path="persona" element={<PersonaPage />} />
        <Route path="knowledge" element={<KnowledgeGraphPage />} />
        <Route path="media" element={<MediaCachePage />} />
        <Route path="stickers" element={<StickersPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export default App;
