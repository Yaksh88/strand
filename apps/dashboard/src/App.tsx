import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";

import { Loading } from "./components/parts";
import { Shell } from "./components/Shell";
import { Runs } from "./pages/Runs";
import { Schedules } from "./pages/Schedules";
import { Settings } from "./pages/Settings";
import { Workers } from "./pages/Workers";

// Pages with charts or the timeline load on demand.
const Overview = lazy(() => import("./pages/Overview").then((m) => ({ default: m.Overview })));
const RunDetail = lazy(() => import("./pages/RunDetail").then((m) => ({ default: m.RunDetail })));

export function App() {
  return (
    <Suspense
      fallback={
        <div className="page">
          <Loading what="the page" />
        </div>
      }
    >
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<Overview />} />
          <Route path="runs" element={<Runs />} />
          <Route path="runs/:id" element={<RunDetail />} />
          <Route path="schedules" element={<Schedules />} />
          <Route path="workers" element={<Workers />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Overview />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
