// "All Stories": the whole scored edition, with filters, a sort control, and
// enough honesty about all three that a reader can trust a count.
//
// LITMUS ships a dedicated desktop version and a dedicated mobile version of
// every page (standing rule, Max 2026-09-13), so this file only chooses between
// them. Both read the edition, the URL state, and every derived list and count
// through stories/useClusterList.ts; the pure filtering, sorting and copy live in
// stories/clusterListLogic.ts, where the history of the page's count defects is
// recorded beside the code that fixed them.

import { useDevice } from "../lib/device.tsx";
import { ClusterListDesktop } from "./stories/ClusterListDesktop.tsx";
import { ClusterListMobile } from "./stories/ClusterListMobile.tsx";

// Re-exported so existing importers (clusterListFeed.test.ts) keep reaching the
// filter and sort logic through the route file.
export { SORT_KEYS, applyFilters, applySort } from "./stories/clusterListLogic.ts";
export type { SortKey } from "./stories/clusterListLogic.ts";

export function ClusterList() {
  const { device } = useDevice();
  return device === "mobile" ? <ClusterListMobile /> : <ClusterListDesktop />;
}
