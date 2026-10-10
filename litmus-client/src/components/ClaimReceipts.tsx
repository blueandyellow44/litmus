// Claim receipts under The Facts. One line per claim, its status, and the
// outlets that carry it — set as a ruled footnote block, not a dashboard.
//
// Status words are deliberately plain: confirmed / contested / unverified.
// "Unverified" is what "unknown" says to a reader, and it is an honest answer,
// not an error state. Nothing here reproduces article text; every source is a
// link out, and paywalled sources say so.

import receiptsFile from "../demo/claim-receipts.json";
import { PALETTE } from "../lib/palette.ts";
import { receiptsForStory, type ClaimReceipt, type ClaimSourceRef, type StoryMember } from "../lib/claims.ts";

const STATUS_LABEL: Record<ClaimReceipt["status"], string> = {
  confirmed: "Confirmed",
  contested: "Contested",
  unknown: "Unverified",
};

// The status word does the work, in the ink scale. Ramp colour is reserved for
// P/H marks (Quiet Reader brand.md section 2) and green/amber/red as verdict
// colours are retired: a status is not a temperature.
const STATUS_COLOR: Record<ClaimReceipt["status"], string> = {
  confirmed: PALETTE.ink,
  contested: PALETTE.ink,
  unknown: PALETTE.ink3,
};

function SourceLink({ s }: { s: ClaimSourceRef }) {
  return (
    <li className="mb-1 last:mb-0">
      <a
        href={s.url}
        target="_blank"
        rel="noopener noreferrer"
        className="underline decoration-1 underline-offset-2 hover:text-ink"
        title={s.supports}
      >
        {s.publisher}
      </a>
      {s.kind === "primary" && <span className="text-ink3"> · primary record</span>}
      {s.paywalled && <span className="text-ink3"> · paywalled, link only</span>}
    </li>
  );
}

function Receipt({ r }: { r: ClaimReceipt }) {
  return (
    <li className="border-t border-rule pt-2.5 mt-2.5 first:border-t-0 first:pt-0 first:mt-0">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span
          className="font-sans text-[10px] uppercase tracking-[0.16em] font-bold whitespace-nowrap"
          style={{ color: STATUS_COLOR[r.status] }}
        >
          {STATUS_LABEL[r.status]}
        </span>
        <span className="font-serif text-sm">{r.claim}</span>
      </div>

      {r.status === "contested" && r.positions ? (
        <div className="mt-1.5 space-y-1.5">
          {r.positions.map((p, i) => (
            <div key={i} className="border-l-2 border-rule pl-3">
              <p className="font-serif text-sm m-0">{p.statement}</p>
              <ul className="list-none p-0 m-0 mt-1 font-sans text-xs text-ink3">
                {p.sources.map((s) => (
                  <SourceLink key={`${s.articleId}-${s.url}`} s={s} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <>
          {r.note && <p className="font-sans text-xs text-ink3 italic m-0 mt-1">{r.note}</p>}
          {r.sources.length > 0 ? (
            <ul className="list-none p-0 m-0 mt-1 font-sans text-xs text-ink3">
              {r.sources.map((s) => (
                <SourceLink key={`${s.articleId}-${s.url}`} s={s} />
              ))}
            </ul>
          ) : (
            <p className="font-sans text-xs text-ink3 italic m-0 mt-1">No source in this edition carries this claim.</p>
          )}
        </>
      )}
    </li>
  );
}

export function ClaimReceipts({
  clusterId,
  members,
}: {
  clusterId: number | null | undefined;
  /** The articles actually in this story — id AND url. A receipt renders only
   *  when EVERY citation it makes (including the sources inside a contested
   *  receipt's positions) matches one of these on the (articleId, canonical
   *  URL) pair, not on either field alone: a citation with the right id and a
   *  stale url is one the reader is invited to check and cannot. See
   *  receiptsForStory in lib/claims.ts. */
  members: readonly StoryMember[];
}) {
  if (typeof clusterId !== "number") return null;
  const receipts = receiptsForStory(receiptsFile, clusterId, members);
  if (receipts.length === 0) return null;

  return (
    <div className="mt-3 pt-2.5 border-t border-rule">
      <div className="font-sans text-[11px] uppercase tracking-[0.2em] text-ink3 mb-2">
        Receipts · {receipts.length} claim{receipts.length === 1 ? "" : "s"}
      </div>
      <ul className="list-none p-0 m-0">
        {receipts.map((r) => (
          <Receipt key={r.id} r={r} />
        ))}
      </ul>
      <p className="font-sans text-xs text-ink3 m-0 mt-2.5">
        Each claim is checked against the outlets in this edition only. Confirmed means two independent outlets or one
        primary record. Unverified means the evidence here does not reach that bar.
      </p>
    </div>
  );
}
