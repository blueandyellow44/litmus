// The weekly letter's form: what it posts and where, and that a site with no
// newsletter behind it shows no form at all.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LetterSignup } from "./LetterSignup.tsx";
import { LETTER_FORM_ACTION, LETTER_PRIVACY_HREF } from "../lib/brand.ts";

const ACTION = "https://buttondown.com/api/emails/embed-subscribe/test-newsletter";
const render = (action: string | null) => renderToStaticMarkup(<LetterSignup placement="rail" action={action} />);

describe("LetterSignup", () => {
  it("renders nothing when no newsletter is configured", () => {
    expect(render(null)).toBe("");
  });

  it("posts the address to the carrier in a new tab, as a plain form", () => {
    const html = render(ACTION);
    expect(html).toContain(`action="${ACTION}"`);
    expect(html).toContain('method="post"');
    expect(html).toContain('target="_blank"');
    expect(html).toMatch(/<input[^>]*type="email"[^>]*name="email"[^>]*required/);
  });

  it("records which form the address came from", () => {
    expect(render(ACTION)).toContain('<input type="hidden" name="tag" value="site-rail"/>');
  });

  it("labels the field and links the privacy note", () => {
    const html = render(ACTION);
    const id = html.match(/<label for="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`id="${id}"`);
    expect(html).toContain(`href="${LETTER_PRIVACY_HREF}"`);
  });

  it("only ever points at Buttondown", () => {
    if (LETTER_FORM_ACTION !== null) expect(LETTER_FORM_ACTION).toMatch(/^https:\/\/buttondown\.com\//);
  });
});
