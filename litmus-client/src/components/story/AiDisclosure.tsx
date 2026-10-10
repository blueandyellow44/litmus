// The page's one AI disclosure (brand.md section 10). It says what AI wrote
// and what it did not, in one place the header's "Legal & AI disclosure" link
// can reach. Exactly one per page: it carries a fixed id, so a second copy is
// a duplicate id and the tests catch it.
//
// The wording is a constant, not a prop: every page must make the same
// statement, and a page that softened it would be the page misdescribing the
// product.

import { LEGAL_HREF } from "../../lib/brand.ts";
import { CONTROL } from "../meta.tsx";

export const AI_DISCLOSURE_ID = "ai-disclosure";
export const AI_DISCLOSURE_HEADING = "What AI wrote here";
export const AI_DISCLOSURE_WROTE =
  "Claude Haiku, an AI model, wrote each story assessment and chose the quoted lines shown as evidence. The Proportionate-to-Hyperbolic scores and band words are judged by Jev, an AI model running on Cloudflare Workers AI. AI also placed each report on the lean axis.";
export const AI_DISCLOSURE_DID_NOT =
  "Quoted lines are the outlets' own words, copied without changes. LITMUS does not publish full articles; every report links to the outlet that published it.";
export const AI_DISCLOSURE_LEGAL_LINK = "Methodology, corrections and how to dispute a finding";

export function AiDisclosure({ className = "" }: { className?: string }) {
  return (
    <section id={AI_DISCLOSURE_ID} aria-labelledby={`${AI_DISCLOSURE_ID}-h`} className={`max-w-prose ${className}`}>
      <h2 id={`${AI_DISCLOSURE_ID}-h`} className="font-sans text-micro uppercase font-semibold text-ink3 m-0 mb-2">
        {AI_DISCLOSURE_HEADING}
      </h2>
      <p className="font-sans text-sm text-ink2 m-0">{AI_DISCLOSURE_WROTE}</p>
      <p className="font-sans text-sm text-ink2 mt-2 mb-0">{AI_DISCLOSURE_DID_NOT}</p>
      <p className="mt-2 mb-0">
        <a
          href={LEGAL_HREF}
          className={`font-sans text-sm text-ink underline decoration-1 underline-offset-2 decoration-rule hover:decoration-ink inline-flex items-center ${CONTROL}`}
        >
          {AI_DISCLOSURE_LEGAL_LINK}
        </a>
      </p>
    </section>
  );
}
