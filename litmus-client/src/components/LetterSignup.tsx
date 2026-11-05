// The weekly letter's signup form: a pitch, then one row of field and button.
// The row is sized to fit the 250px desktop rail, the narrowest place it sits,
// so the rail, the phone feed and the phone footer all use it unchanged.
//
// It is a plain HTML form posted to Buttondown in a new tab, never a fetch.
// Buttondown's response page is where a reader finishes (a CAPTCHA, a typo in
// the address), and its docs say not to submit the form from script for that
// reason. So there is no request to wait on here: the only state this
// component owns is "the form went out", which swaps the pitch for where to
// look next.
//
// `tag` records which form the address came from, so signups can be counted
// by placement.

import { useId, useState } from "react";
import { LETTER_FORM_ACTION, LETTER_NAME, LETTER_PITCH, LETTER_PRIVACY_HREF } from "../lib/brand.ts";
import { CONTROL, FOCUS_RING } from "./meta.tsx";

export type LetterPlacement = "front-feed" | "rail" | "footer";

const MICRO = "font-sans text-[11.5px] font-semibold uppercase tracking-[0.12em] text-ink3";

// 16px on the input: iOS zooms the page on focus below that.
const INPUT = `flex-1 min-w-0 font-sans text-[16px] text-ink placeholder:text-ink3 bg-surface border border-ink3 rounded-none px-3 ${CONTROL}`;
const BUTTON = `font-sans text-[14px] font-semibold text-ground bg-ink border border-ink px-3 whitespace-nowrap cursor-pointer hover:bg-ink2 ${CONTROL}`;
const NOTE_LINK = `underline decoration-1 underline-offset-2 hover:text-ink ${FOCUS_RING}`;

export function LetterSignup({
  placement,
  action = LETTER_FORM_ACTION,
  className = "",
}: {
  placement: LetterPlacement;
  action?: string | null;
  className?: string;
}) {
  const inputId = useId();
  const [sent, setSent] = useState(false);

  if (!action) return null;

  return (
    <section aria-label={LETTER_NAME} className={`font-sans text-left ${className}`}>
      <p className={`${MICRO} m-0`}>{LETTER_NAME}</p>
      <p className="text-[14px] leading-[1.45] text-ink2 m-0 mt-1.5">{LETTER_PITCH}</p>

      <form
        action={action}
        method="post"
        target="_blank"
        rel="noopener"
        onSubmit={() => setSent(true)}
        className="mt-3 flex gap-2"
      >
        <label htmlFor={inputId} className="sr-only">
          Email address
        </label>
        <input
          id={inputId}
          type="email"
          name="email"
          required
          autoComplete="email"
          placeholder="Email address"
          className={INPUT}
        />
        <input type="hidden" name="tag" value={`site-${placement}`} />
        <button type="submit" className={BUTTON}>
          Subscribe
        </button>
      </form>

      <p role="status" className="text-[12.5px] leading-[1.45] text-ink3 m-0 mt-2">
        {sent ? (
          "Finish in the tab that just opened."
        ) : (
          <>
            Free. Sent by Buttondown, which holds your address.{" "}
            {/* Plain anchor: /legal is a static file the SPA router cannot serve. */}
            <a href={LETTER_PRIVACY_HREF} className={NOTE_LINK}>
              Privacy
            </a>
          </>
        )}
      </p>
    </section>
  );
}
