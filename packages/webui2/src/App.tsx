import { Route, Routes } from "react-router";
import { AppLayout } from "./layouts/AppLayout.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { NotFoundPage } from "./pages/NotFoundPage.tsx";
import { TestIndexPage, TestOverviewPage, TestPreviewPage, TestScenesPage } from "./pages/TestPages.tsx";

function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<HomePage />} />
        <Route path="tests" element={<TestIndexPage />} />
        <Route path="tests/overview" element={<TestOverviewPage />} />
        <Route path="tests/scenes" element={<TestScenesPage />} />
        <Route path="tests/scenes/preview" element={<TestPreviewPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export default App;
