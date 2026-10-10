// The page shell. LITMUS ships a dedicated desktop version and a dedicated
// mobile version of every page (standing rule, Max 2026-09-13), so this only
// chooses between them. The shells themselves live in ./layout/.

import { useDevice } from "../lib/device.tsx";
import { LayoutDesktop } from "./layout/LayoutDesktop.tsx";
import { LayoutMobile } from "./layout/LayoutMobile.tsx";

export function Layout() {
  const { device } = useDevice();
  return device === "mobile" ? <LayoutMobile /> : <LayoutDesktop />;
}
