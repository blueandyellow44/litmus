// The LITMUS wordmark: the ramp mark, then the name in caps.
//
// Spec: design/rebrand-2026-09-13/quiet-reader/brand.md section 1. The ramp mark
// is five bars filled with the P/H ramp from Proportionate to Hyperbolic. It is the
// only decorative element in the identity and it is data: the scale the product
// measures. The bars read their colours from PH_BANDS, so the mark cannot drift
// from the dots and swatches it summarises. No nameplate, no serif logotype.

import { Link } from "react-router-dom";
import { BRAND_NAME } from "../lib/brand.ts";
import { PH_BANDS } from "../lib/phBand.ts";
import { FOCUS_RING } from "./meta.tsx";

// Bar geometry from the spec, in px.
const BAR_WIDTH = 5;
const BAR_HEIGHT = 15;
const BAR_GAP = 2;

export function RampMark({ scale = 1 }: { scale?: number }) {
  return (
    <span aria-hidden className="inline-flex shrink-0" style={{ gap: BAR_GAP * scale }}>
      {PH_BANDS.map((b) => (
        <span
          key={b.label}
          className="block rounded-[1px]"
          style={{ width: BAR_WIDTH * scale, height: BAR_HEIGHT * scale, backgroundColor: b.hex }}
        />
      ))}
    </span>
  );
}

// A link home. `className` tunes placement only; the lockup itself (17px,
// 600, 0.2em tracking, 11px gap) is fixed on both versions.
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <Link
      to="/"
      aria-label={`${BRAND_NAME}, home`}
      className={`inline-flex items-center gap-[11px] font-sans font-semibold text-[17px] leading-none tracking-[0.2em] text-ink no-underline ${FOCUS_RING} ${className}`}
    >
      <RampMark />
      <span>{BRAND_NAME}</span>
    </Link>
  );
}
