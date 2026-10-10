// A section front: the section's trending story rendered as the full LITMUS
// spread — The Facts, the Map, and the calmest-vs-hottest contrast — followed by
// The Coverage of every outlet's take and the rest of the desk. "Reading as"
// reweights which telling leads; it never hides coverage.
//
// LITMUS ships a dedicated desktop version and a dedicated mobile version of
// every page (standing rule, Max 2026-09-13), so this only chooses between them.
// Both read the same model through section/useSectionPage.ts.

import { useDevice } from "../lib/device.tsx";
import { SectionPageDesktop } from "./section/SectionPageDesktop.tsx";
import { SectionPageMobile } from "./section/SectionPageMobile.tsx";

export function SectionPage() {
  const { device } = useDevice();
  return device === "mobile" ? <SectionPageMobile /> : <SectionPageDesktop />;
}
