// The roster: every source LITMUS reads, and the baseline it assigns each one.
// LITMUS ships a dedicated desktop version and a dedicated mobile version of
// every page (standing rule, Max 2026-09-13), so this only chooses between them;
// both read the roster through pages/sources/useSources.ts.
//
// This page was reachable by URL but linked from nowhere, and its copy told the
// reader that toggles "arrive in Phase 7", an internal roadmap note on a public
// surface. It now says what it is: the record of who LITMUS reads and how it
// classifies them, which is the one thing a reader needs to judge whether the
// Outlet baseline printed on every article means anything.
//
// It deliberately does NOT show `reliability`. That field is an internal
// judgement with no published rubric and no named authority (see
// litmus-server/sources/README.md); printing it would present an opinion as a
// rating of a publication.

import { useDevice } from "../lib/device.tsx";
import { SourceConfigDesktop } from "./sources/SourceConfigDesktop.tsx";
import { SourceConfigMobile } from "./sources/SourceConfigMobile.tsx";

export function SourceConfig() {
  const { device } = useDevice();
  return device === "mobile" ? <SourceConfigMobile /> : <SourceConfigDesktop />;
}
