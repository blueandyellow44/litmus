// Small and plain: "by Max Sheahan", linking out to maxsheahan.com. It carries
// none of that site's colours, type or marks (brand.md section 10, ruling 18
// on whose brand goes where). Both shells and every story surface use this one.

import { BYLINE_HREF, BYLINE_TEXT } from "../../lib/brand.ts";
import { FOCUS_RING } from "../meta.tsx";

export function Byline({ className = "" }: { className?: string }) {
  return (
    <a
      href={BYLINE_HREF}
      className={`font-sans text-[13px] text-ink2 no-underline border-b border-rule hover:border-ink2 ${FOCUS_RING} ${className}`}
    >
      {BYLINE_TEXT}
    </a>
  );
}
