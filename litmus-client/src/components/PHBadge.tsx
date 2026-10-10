// The 1.0–5.0 P/H score chip: a ramp swatch, the number, and the band word.
// Colour and word both come from the composite, via the one band table in
// lib/phBand.ts.
//
// Quiet Reader form (brand.md section 2): `● 2.3 Grounded`. The number is ink,
// the word ink2, and the ramp colour only fills the swatch. It used to be white
// text on a band-coloured pill, which the new ramp cannot carry: the pale steps
// are under 2:1 against white text (phBand.test.ts measures why).
//
// The badge derives everything from the number; the `label` prop is accepted
// only for backward compatibility at call sites that still pass one. A row whose
// stored label had gone stale used to render the stale word in the stale colour.
//
// A composite that is not a composite (NaN, Infinity, a string, 7.2) renders as
// an explicit "Not rated" chip with a hollow swatch. It must never render as
// Practical, which is what the old fall-through did.

import { bandForComposite, MARK_STROKE, UNRATED_LABEL } from "../lib/phBand.ts";
import type { Label } from "../lib/types.ts";

interface Props {
  // Deliberately `unknown`: this is the boundary where data from a snapshot or
  // an API meets the type system, and typing it `number` would only move the lie
  // upstream to a cast.
  composite: unknown;
  // Ignored for rendering. Kept so existing call sites compile.
  label?: Label | string | null;
  size?: "sm" | "md" | "lg";
}

const SIZE_CLASSES: Record<NonNullable<Props["size"]>, string> = {
  sm: "text-[13px] gap-1.5",
  md: "text-[14px] gap-[7px]",
  lg: "text-[16px] gap-2",
};

// Swatch diameter in px per size. 11px is the spec's size beside 13.5px text.
const SWATCH_PX: Record<NonNullable<Props["size"]>, number> = { sm: 10, md: 11, lg: 13 };

export function PHBadge({ composite, size = "md" }: Props) {
  const band = bandForComposite(composite);
  const swatch = SWATCH_PX[size];

  if (!band) {
    return (
      <span
        className={`inline-flex items-center whitespace-nowrap font-sans font-medium text-ink3 ${SIZE_CLASSES[size]}`}
        title="This article has no usable Proportionate-to-Hyperbolic score in this edition."
      >
        {/* Hollow: an unrated score has no temperature to fill the mark with. */}
        <span
          aria-hidden
          className="inline-block shrink-0 rounded-full"
          style={{ width: swatch, height: swatch, boxShadow: `inset 0 0 0 1.5px ${MARK_STROKE}` }}
        />
        {UNRATED_LABEL}
      </span>
    );
  }

  const value = (composite as number).toFixed(1);
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap font-sans font-medium text-ink2 tabular-nums ${SIZE_CLASSES[size]}`}
      title={`${band.label}: composite ${value} on the Proportionate-to-Hyperbolic scale`}
    >
      <span
        aria-hidden
        className="inline-block shrink-0 rounded-full"
        style={{ width: swatch, height: swatch, backgroundColor: band.hex, boxShadow: `inset 0 0 0 1px ${MARK_STROKE}` }}
      />
      <span className="font-semibold text-ink">{value}</span>
      <span>{band.label}</span>
    </span>
  );
}
