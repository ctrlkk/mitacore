import { lazy, Suspense, type ComponentType } from "react";
import { Route, Routes } from "react-router";

function lazyPage(load: () => Promise<ComponentType>) {
  return lazy(async () => ({ default: await load() }));
}

const AppLayout = lazyPage(async () => (await import("./layouts/AppLayout.tsx")).AppLayout);
const HomePage = lazyPage(async () => (await import("./pages/HomePage.tsx")).HomePage);
const ModelConfigPage = lazyPage(async () => (await import("./pages/ModelConfigPage.tsx")).ModelConfigPage);
const PersonaPage = lazyPage(async () => (await import("./pages/PersonaPage.tsx")).PersonaPage);
const KnowledgeGraphPage = lazyPage(async () => (await import("./pages/KnowledgeGraphPage.tsx")).KnowledgeGraphPage);
const MediaCachePage = lazyPage(async () => (await import("./pages/MediaCachePage.tsx")).MediaCachePage);
const StickersPage = lazyPage(async () => (await import("./pages/StickersPage.tsx")).StickersPage);
const NotFoundPage = lazyPage(async () => (await import("./pages/NotFoundPage.tsx")).NotFoundPage);

function App() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">正在加载页面</div>
      }
    >
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<HomePage />} />
          <Route path="models" element={<ModelConfigPage />} />
          <Route path="persona" element={<PersonaPage />} />
          <Route path="knowledge" element={<KnowledgeGraphPage />} />
          <Route path="media" element={<MediaCachePage />} />
          <Route path="stickers" element={<StickersPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

export default App;
