// The front page: the whole edition as one scroll of repeated items. LITMUS
// ships a dedicated desktop version and a dedicated mobile version of every page
// (standing rule, Max 2026-09-13), so this only chooses between them; both read
// the same edition through lib/useWire.ts.
//
// The scroll replaced the lead "spread" (The Facts, the Map, a calmest-vs-hottest
// pair, a section digest) on 2026-09-13. An audit of the live paper found the
// spread stacked about sixteen labels before the first quoted sentence, paired
// tellings of different events under "same story", and put "Hottest telling" in
// red over two Grounded pieces on most days. The spread still exists on section
// pages, where a reader who wants every telling side by side goes on purpose.

import { useDevice } from "../lib/device.tsx";
import { FrontPageDesktop } from "./front/FrontPageDesktop.tsx";
import { FrontPageMobile } from "./front/FrontPageMobile.tsx";

export function FrontPage() {
  const { device } = useDevice();
  return device === "mobile" ? <FrontPageMobile /> : <FrontPageDesktop />;
}
