import { Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout.tsx";
import { FrontPage } from "./pages/FrontPage.tsx";
import { SectionPage } from "./pages/SectionPage.tsx";
import { ClusterList } from "./pages/ClusterList.tsx";
import { ArticleDetail } from "./pages/ArticleDetail.tsx";
import { SourceConfig } from "./pages/SourceConfig.tsx";
import { About } from "./pages/About.tsx";
import { DeviceProvider } from "./lib/device.tsx";
import { LANDING_PATHS } from "./components/layout/shared.tsx";

export default function App() {
  return (
    <DeviceProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<FrontPage />} />
          {/* Share links (/substack): the front page under a countable path. */}
          {LANDING_PATHS.map((p) => (
            <Route key={p} path={p.slice(1)} element={<FrontPage />} />
          ))}
          {/* Every scored article, as a flat feed with a group-by-story toggle.
              This page existed and was rendered by nothing: it had no route, so
              it could not be reached at all. Meanwhile the section pages surface
              roughly one story each, which meant a run that scored 150 articles
              displayed 15 and the other 135 — each with a P/H score and its
              highlights — were invisible to every reader. */}
          <Route path="stories" element={<ClusterList />} />
          <Route path="s/:slug" element={<SectionPage />} />
          <Route path="articles/:id" element={<ArticleDetail />} />
          <Route path="sources" element={<SourceConfig />} />
          <Route path="about" element={<About />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </DeviceProvider>
  );
}
