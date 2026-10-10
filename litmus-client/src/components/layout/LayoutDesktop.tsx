// The desktop page shell, Quiet Reader edition: a sticky 250px left rail
// beside the page content, matching the approved mock's .shell grid exactly
// (max-width 1360px, 40px side padding, 72px gap — design/rebrand-2026-09-13/
// quiet-reader/front-desktop.html). Replaces the earlier horizontal header +
// tab-nav shell (2026-09-17): that pattern read as a settings panel rather
// than a paper, on top of already carrying the Reading-as toggle this session
// also cut.
//
// Retired with the broadsheet identity (brand.md section 11): the 84px engraved
// nameplate, the double-rule dateline, "Vol. I No. 1" and the "Front Page" name.

import { Outlet } from "react-router-dom";
import { Rail } from "./Rail.tsx";

export function LayoutDesktop() {
  return (
    <div className="max-w-[1360px] mx-auto px-10 grid grid-cols-[250px_minmax(0,1fr)] gap-[72px] items-start">
      <Rail />
      <main className="min-w-0 py-11 pb-16">
        <Outlet />
      </main>
    </div>
  );
}
