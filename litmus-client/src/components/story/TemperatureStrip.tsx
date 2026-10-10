// The temperature strip (graft 1, Signal Strip): the five ramp steps as a thin
// bar, a tick for every scored report, and a bracket from the story's calmest
// telling to its hottest, with the range written out as number plus band word.
// A reader scanning the stream sees which stories run hot before reading a
// word; a reader who cannot see colour reads the same fact in the text.
//
// Layout comes from lib/stripGeometry.ts. Ramp colour fills the segments only;
// the ticks and bracket are ink.

import { PALETTE } from "../../lib/palette.ts";
import { MARK_STROKE, bandWord } from "../../lib/phBand.ts";
import { stripGeometry } from "../../lib/stripGeometry.ts";

interface Props {
  composites: readonly unknown[];
  className?: string;
  // Hide the written range when the caller prints it elsewhere on the same
  // line (the strip is then decorative and says so to assistive tech).
  showRange?: boolean;
}

const STRIP_HEIGHT_PX = 18;
const BAR_TOP_PX = 4;
const BAR_HEIGHT_PX = 6;
const TICK_WIDTH_PX = 2;
const BRACKET_TOP_PX = 13;
const BRACKET_CAP_PX = 4;

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

export function TemperatureStrip({ composites, className = "", showRange = true }: Props) {
  const g = stripGeometry(composites);
  const scored = g.ticks.length;
  const label = `Temperature strip: ${g.rangeText}, ${scored} scored report${scored === 1 ? "" : "s"}`;

  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${className}`}>
      <div
        role="img"
        aria-label={label}
        className="relative min-w-[120px] flex-1 basis-[160px]"
        style={{ height: STRIP_HEIGHT_PX }}
      >
        {g.segments.map((s) => (
          <span
            key={s.band.label}
            aria-hidden
            className="absolute block"
            style={{
              left: pct(s.from),
              width: pct(s.to - s.from),
              top: BAR_TOP_PX,
              height: BAR_HEIGHT_PX,
              backgroundColor: s.band.hex,
              boxShadow: `inset 0 0 0 1px ${MARK_STROKE}`,
            }}
          />
        ))}
        {g.ticks.map((t, i) => (
          <span
            key={`${t.composite}-${i}`}
            aria-hidden
            title={`${t.composite.toFixed(1)} ${t.band.label}`}
            className="absolute block"
            style={{
              left: `calc(${pct(t.fraction)} - ${TICK_WIDTH_PX / 2}px)`,
              width: TICK_WIDTH_PX,
              top: 0,
              height: BAR_TOP_PX + BAR_HEIGHT_PX + 3,
              backgroundColor: PALETTE.ink,
            }}
          />
        ))}
        {g.bracket && (
          <span
            aria-hidden
            className="absolute block"
            style={{
              left: pct(g.bracket.from),
              width: `max(${pct(g.bracket.to - g.bracket.from)}, 2px)`,
              top: BRACKET_TOP_PX,
              height: BRACKET_CAP_PX,
              borderLeft: `1.5px solid ${PALETTE.ink2}`,
              borderRight: `1.5px solid ${PALETTE.ink2}`,
              borderBottom: `1.5px solid ${PALETTE.ink2}`,
            }}
          />
        )}
      </div>
      {showRange && (
        <span className="font-sans text-meta text-ink2 tabular-nums whitespace-nowrap">
          {g.bracket ? (
            <>
              <span className="font-semibold text-ink">{g.bracket.min.toFixed(1)}</span> {bandWord(g.bracket.min)}
              {g.bracket.min !== g.bracket.max && (
                <>
                  {" to "}
                  <span className="font-semibold text-ink">{g.bracket.max.toFixed(1)}</span> {bandWord(g.bracket.max)}
                </>
              )}
            </>
          ) : (
            g.rangeText
          )}
        </span>
      )}
    </div>
  );
}
