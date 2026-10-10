// /substack is the front page under a countable path: the Stories link must
// stay marked there, and an unrelated path must not borrow the alias.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { Rail } from "./Rail.tsx";
import { DeviceProvider } from "../../lib/device.tsx";

function storiesLink(path: string): string {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <DeviceProvider>
        <Rail />
      </DeviceProvider>
    </MemoryRouter>,
  );
  const m = html.match(/<a[^>]*href="\/"[^>]*>Stories<\/a>/);
  if (!m) throw new Error("no Stories link");
  return m[0];
}

describe("landing paths", () => {
  it("marks Stories on the front page", () => {
    expect(storiesLink("/")).toContain("font-semibold");
  });
  it("marks Stories on /substack", () => {
    expect(storiesLink("/substack")).toContain("font-semibold");
  });
  it("does not mark Stories on /about", () => {
    expect(storiesLink("/about")).not.toContain("font-semibold");
  });
});
