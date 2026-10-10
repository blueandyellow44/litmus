// The About page: the mission thesis, the two readings, and the P/H bands.
// LITMUS ships a dedicated desktop version and a dedicated mobile version of
// every page (standing rule, Max 2026-09-13), so this only chooses between
// them. Both render the same words from about/AboutCopy.tsx and the same band
// rows from about/aboutContent.ts, which reads them from lib/phBand.ts.

import { useDevice } from "../lib/device.tsx";
import { AboutDesktop } from "./about/AboutDesktop.tsx";
import { AboutMobile } from "./about/AboutMobile.tsx";

export function About() {
  const { device } = useDevice();
  return device === "mobile" ? <AboutMobile /> : <AboutDesktop />;
}
