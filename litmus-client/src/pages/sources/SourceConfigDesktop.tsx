// The desktop roster: two columns. The left rail carries the heading, counts
// and caveat, then a jump list of the baselines that stays pinned while the
// reader scrolls; the right column is the table, grouped by outlet baseline,
// with the outlet's kind, access and whether LITMUS reads it in their own
// columns so a reader can scan down any one of them. The caveat still comes
// before the table in reading order. Not sortable: the page never was, and
// baseline order is the reading the page exists to show.
//
// Why the rail: sixty-odd rows in one full-width table left a gap of about
// 500px between each name and its attributes, lost the column labels after the
// first screen, and gave no way to move between baselines (a browser QA pass,
// 2026-09-13). Narrowing the table closes the gap, the column labels are
// sticky, and the rail's links use the same baseline-* anchors as the mobile
// version.
//
// The table uses separate borders with every rule on the cells. Collapsed
// borders drew a lighter seam where a full-width heading cell met the column
// cells below it, and they do not travel with a sticky header cell.
//
// Data and every derived value come from ./useSources.ts, shared with
// SourceConfigMobile.tsx.

import { Link } from "react-router-dom";
import { CONTROL, FOCUS_RING } from "../../components/meta.tsx";
import { useSources } from "./useSources.ts";
import { useActiveBaseline } from "./useActiveBaseline.ts";
import { RosterCaveat, ROSTER_SCOPE } from "./RosterCaveat.tsx";
import { accessLabel, groupAnchor, readLabel, rosterCountLine, sourceTypeLabel } from "./roster.ts";

// The pinned header band, shared by the table's column labels and the rail's
// "Outlet baseline" label so the two sit on one line while scrolling. Before,
// the rail pinned at 24px and the column labels at 0, visibly out of line
// (browser QA, 2026-09-13). A fixed height, not padding, so the group heading
// row below knows where to pin.
const HEAD_BAND = "h-9 border-b-2 border-ink text-[11px] uppercase tracking-[0.12em] text-ink3";

// Every column label cell: pinned to the top of the viewport while its table is
// on screen, on the paper colour so rows do not show through.
const COLUMN_HEAD = `sticky top-0 z-10 bg-ground py-0 align-middle font-normal ${HEAD_BAND}`;

// Where a group heading row pins: just under the 36px column labels, tucked 2px
// beneath them (the labels paint above it) so no sliver of a row can show
// through between the two whatever the cell's border arithmetic comes to.
const GROUP_HEAD_TOP = "top-[34px]";

// The line the rail's active state measures against: a group is current once
// its heading row has reached the pinned position under the column labels.
const PIN_LINE_PX = 40;

export function SourceConfigDesktop() {
  const { roster, error } = useSources();
  const active = useActiveBaseline(roster ? roster.groups.map((g) => groupAnchor(g.key)) : [], PIN_LINE_PX);

  if (error) {
    return (
      <div>
        <Link to="/" className={`font-sans text-sm text-ink3 hover:text-ink ${FOCUS_RING}`}>
          ← Top stories
        </Link>
        <p className="mt-4">
          Could not load the roster. <span className="text-ink3">{error}</span>
        </p>
      </div>
    );
  }

  if (!roster) return <p className="text-ink3">Loading the roster…</p>;

  return (
    <div className="grid grid-cols-[minmax(0,4fr)_minmax(0,8fr)] gap-10">
      {/* The rail stretches to the table's full height so the jump list below
          has room to stay pinned all the way down. */}
      <div>
        <h1 className="font-serif text-h1 mb-2">Sources</h1>
        <p className="font-sans text-sm text-ink3 m-0 mb-5">
          {rosterCountLine(roster)} {ROSTER_SCOPE}
        </p>
        <RosterCaveat className="text-sm" />

        {roster.total > 0 && (
          <nav aria-label="Jump to an outlet baseline" className="sticky top-0 mt-8 font-sans">
            <p className={`${HEAD_BAND} m-0 flex items-center`}>Outlet baseline</p>
            <ul className="list-none p-0 m-0">
              {roster.groups.map((g) => {
                const anchor = groupAnchor(g.key);
                const current = active === anchor;
                // The rail marks the group in view, so the classification of the
                // rows on screen is always readable at a glance.
                return (
                  <li key={g.key} className="border-b border-rule">
                    <a
                      href={`#${anchor}`}
                      aria-current={current ? "location" : undefined}
                      className={`flex items-center justify-between text-sm text-ink hover:bg-ink/5 pl-2 pr-1 border-l-[3px] ${
                        current ? "border-ink bg-ink/5 font-semibold" : "border-transparent"
                      } ${CONTROL}`}
                    >
                      {g.label}
                      <span className="text-ink3">{g.items.length}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}
      </div>

      {roster.total === 0 ? (
        <p className="text-ink3">The roster is empty.</p>
      ) : (
        <table className="w-full self-start border-separate border-spacing-0 font-sans text-sm">
          <caption className="sr-only">Outlets LITMUS reads, grouped by outlet baseline</caption>
          <thead>
            <tr className="text-left">
              <th scope="col" className={`${COLUMN_HEAD} pr-4`}>
                Outlet
              </th>
              <th scope="col" className={`${COLUMN_HEAD} pr-4 w-[22%]`}>
                Kind
              </th>
              <th scope="col" className={`${COLUMN_HEAD} pr-4 w-[20%]`}>
                Access
              </th>
              <th scope="col" className={`${COLUMN_HEAD} w-[12%] text-right`}>
                Status
              </th>
            </tr>
          </thead>
          {roster.groups.map((g) => (
            // scroll-mt lands the group exactly under the sticky column labels.
            <tbody key={g.key} id={groupAnchor(g.key)} className="scroll-mt-9">
              <tr>
                {/* The group heading pins under the column labels too, so the
                    baseline of the rows on screen stays in the table itself and
                    not only in the rail. Each later group's heading slides over
                    the one before it. */}
                <th
                  scope="colgroup"
                  colSpan={4}
                  className={`sticky ${GROUP_HEAD_TOP} z-[5] bg-ground pt-4 pb-2 text-left text-sm uppercase tracking-wider text-ink3 font-normal border-b border-rule-strong`}
                >
                  <span className="text-ink3">Outlet baseline: </span>
                  <span className="text-ink">{g.label}</span>
                  <span className="ml-2">{g.items.length}</span>
                </th>
              </tr>
              {g.items.map((s) => (
                <tr key={s.id}>
                  <th scope="row" className="py-2 pr-4 text-left font-normal border-b border-rule">
                    <span className="font-serif text-base">{s.name}</span>
                  </th>
                  <td className="py-2 pr-4 text-ink3 border-b border-rule">{sourceTypeLabel(s.type)}</td>
                  <td className="py-2 pr-4 text-ink3 border-b border-rule">{accessLabel(s.paywallStatus)}</td>
                  <td
                    className={`py-2 text-right border-b border-rule ${s.enabled ? "text-ink" : "text-ink3"}`}
                  >
                    {readLabel(s.enabled)}
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      )}
    </div>
  );
}
