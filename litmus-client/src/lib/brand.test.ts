// The identity, held to the ruling: the tagline, the two faces, and the absence
// of the broadsheet props. Read from disk where the claim lives in a file the
// bundle does not import (index.html, tailwind.config.js, the shells), because
// a brand rule that only lives in a design document is a rule nobody runs.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BRAND_NAME, BYLINE_HREF, BYLINE_TEXT, TAGLINE } from "./brand.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const INDEX_HTML = read("index.html");
const TAILWIND = read("tailwind.config.js");
const TOKENS_CSS = read("src/styles/tokens.css");

// Every source file the shells and pages are built from. Tests and the demo
// snapshot are skipped: a test may quote a retired string on purpose, and the
// snapshot is data.
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "demo") continue;
      out.push(...sourceFiles(path));
    } else if (/\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}
const SOURCES = sourceFiles(join(ROOT, "src")).map((path) => ({ path: path.slice(ROOT.length), text: read(path.slice(ROOT.length)) }));

// Everything else a browser is served: the shell, the static legal page, the
// favicon. These are not bundled, so nothing else in the suite reads them, and a
// retired colour or a retired word can sit in one of them indefinitely.
const PUBLIC = readdirSync(join(ROOT, "public"))
  .filter((name) => /\.(html|css|svg)$/.test(name))
  .map((name) => ({ path: `public/${name}`, text: read(join("public", name)) }));

// Every surface the sweep covers. tailwind.config.js is in for the hex scan:
// it is where a retired colour would come back as a named token.
const SURFACES = [
  ...SOURCES,
  ...PUBLIC,
  { path: "index.html", text: INDEX_HTML },
  { path: "tailwind.config.js", text: TAILWIND },
];

// Code lines only. A comment is allowed to name what was retired; the shells
// are not allowed to render it.
function codeLines(text: string): string[] {
  return text.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line));
}

describe("the tagline", () => {
  it("is the ruled one, and not the mock's wording the engine spec forbids", () => {
    expect(TAGLINE).toBe("What happened, and how each outlet told it.");
    expect(TAGLINE.toLowerCase()).not.toContain("bent");
  });

  it("is the document title and the meta description", () => {
    expect(INDEX_HTML).toContain(`<title>${BRAND_NAME} · ${TAGLINE}</title>`);
    const description = /<meta name="description" content="([^"]*)"/.exec(INDEX_HTML)?.[1];
    expect(description).toBeDefined();
    expect(description!.startsWith(TAGLINE)).toBe(true);
  });

  it("has no em dash anywhere in the shell copy", () => {
    expect(TAGLINE).not.toContain("—");
    expect(INDEX_HTML).not.toContain("—");
  });
});

describe("the faces", () => {
  it("load Newsreader and Instrument Sans from Google Fonts, with the weights the spec names", () => {
    const href = /href="(https:\/\/fonts\.googleapis\.com\/css2\?[^"]+)"/.exec(INDEX_HTML)?.[1];
    expect(href).toBeDefined();
    expect(href).toContain("family=Instrument+Sans:wght@400;500;600");
    expect(href).toContain("family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400");
    expect(href).toContain("display=swap");
    expect(INDEX_HTML).toContain('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />');
  });

  it("fall back to system faces in both places a family is declared", () => {
    // Tailwind's font-serif / font-sans, and the CSS variables the shells and
    // legal.html read. A blocked font request degrades the face, not the page.
    expect(TAILWIND).toMatch(/serif:\s*\["Newsreader",\s*"Georgia",\s*'"Times New Roman"',\s*"serif"\]/);
    expect(TAILWIND).toMatch(/sans:\s*\['"Instrument Sans"',\s*"system-ui"/);
    expect(TOKENS_CSS).toMatch(/--serif:\s*"Newsreader",\s*Georgia,\s*"Times New Roman",\s*serif;/);
    expect(TOKENS_CSS).toMatch(/--sans:\s*"Instrument Sans",\s*system-ui/);
  });
});

describe("the wordmark and byline", () => {
  it("names the product in caps and the author plainly", () => {
    expect(BRAND_NAME).toBe("LITMUS");
    expect(BYLINE_TEXT).toBe("by Max Sheahan");
    expect(BYLINE_HREF).toBe("https://maxsheahan.com");
  });

  it("uses the ramp mark as the favicon", () => {
    // The five bars, Practical to Hysterical, and nothing else in the file.
    const svg = read("public/favicon.svg");
    const fills = [...svg.matchAll(/fill="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1]!.toUpperCase());
    expect(fills).toEqual(["#C0C9CE", "#B7AE8E", "#C1893C", "#C05A16", "#AD3118"]);
    expect(INDEX_HTML).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
  });
});

describe("the broadsheet props are gone from every rendered surface", () => {
  // The retired identity (brand.md section 11), as the strings a shell would
  // have to contain to render it.
  const RETIRED_COPY = ["Vol. I", "No. 1", "Front Page", "how it's being bent", "how it’s being bent"];
  // Tailwind names that no longer exist in the config. A class that resolves to
  // nothing fails silently: the element renders with no colour at all.
  const RETIRED_CLASSES = ["text-muted", "bg-paper", "text-paper", "border-rule-dark", "bg-white", "border-double", "text-red-", "text-blue-", "bg-red-", "bg-blue-"];

  it.each(RETIRED_COPY)("prints no %s", (needle) => {
    for (const { path, text } of SOURCES) {
      for (const line of codeLines(text)) {
        expect(line, `${path}: ${line.trim()}`).not.toContain(needle);
      }
    }
    for (const { path, text } of [...PUBLIC, { path: "index.html", text: INDEX_HTML }]) {
      for (const line of codeLines(text)) {
        expect(line, `${path}: ${line.trim()}`).not.toContain(needle);
      }
    }
  });

  // The broadsheet colours, as the literals a file would have to contain to
  // bring them back: cream paper and warm rules, the old green-to-red P/H ramp,
  // and the red/blue lean segments. palette.test.ts holds tokens.css and
  // tailwind.config.js to the neutrals; this covers every other surface.
  const RETIRED_HEXES = [
    "#f4efe4", "#14120f", "#6b655c", "#cfc8b9", "#8f8a7d",
    "#166534", "#55701a", "#854d0e", "#b23c0b", "#b91c1c",
    "#3b82f6", "#7dd3fc", "#a3a3a3", "#fda4af", "#dc2626",
  ];

  it.each(RETIRED_CLASSES)("references no %s class", (cls) => {
    for (const { path, text } of SURFACES) {
      for (const line of codeLines(text)) {
        expect(line, `${path}: ${line.trim()}`).not.toContain(cls);
      }
    }
  });

  it.each(RETIRED_HEXES)("paints no %s", (hex) => {
    for (const { path, text } of SURFACES) {
      for (const line of codeLines(text)) {
        expect(line.toLowerCase(), `${path}: ${line.trim()}`).not.toContain(hex);
      }
    }
  });

  it("would catch a retired class if one came back", () => {
    // Watched to fail: the line shared.tsx carried until 2026-09-13.
    const stale = '<div className="text-[11px] uppercase tracking-[0.18em] text-muted">';
    expect(codeLines(stale).some((line) => RETIRED_CLASSES.some((cls) => line.includes(cls)))).toBe(true);
  });
});

describe("the mobile prose floor", () => {
  // brand.md section 3: on mobile all running prose is 16px or larger, and only
  // labels, meta lines and chart annotations go below it. The check is a floor,
  // not a proof: it reads `<p` tags in the dedicated mobile versions, since that
  // is where running prose lives, and it skips the label roles by name.
  const LABEL_ROLES = ["uppercase", "tabular-nums", "text-micro", "text-meta"];
  const UNDER_16 = /text-\[(?:[0-9]|1[0-5])(?:\.[0-9]+)?px\]/;

  // The debt C3 inherits, frozen exactly. These paragraphs predate the Quiet
  // Reader pass and C3 rebuilds the pages they live on (story-first plan, C3).
  // A new sub-16px paragraph anywhere fails here; fixing one fails here too, and
  // the fix is to lower the number or drop the line.
  const DEBT: Record<string, number> = {
    "src/components/wire/WireItemMobile.tsx": 2,
    "src/pages/article/ArticleDetailMobile.tsx": 2,
    // front/FrontPageMobile.tsx paid off (story-first rebuild, 2026-09-17).
    "src/pages/section/SectionPageMobile.tsx": 8,
    "src/pages/sources/SourceConfigMobile.tsx": 2,
    "src/pages/stories/ArticleFeedRowMobile.tsx": 3,
    "src/pages/stories/ClusterCardMobile.tsx": 2,
    "src/pages/stories/ClusterListMobile.tsx": 6,
  };

  function offenders(): Record<string, number> {
    const found: Record<string, number> = {};
    for (const { path, text } of SOURCES) {
      if (!path.endsWith("Mobile.tsx")) continue;
      for (const line of codeLines(text)) {
        if (!/<p[\s>]/.test(line) || !UNDER_16.test(line)) continue;
        if (LABEL_ROLES.some((role) => line.includes(role))) continue;
        found[path.replace(/^\//, "")] = (found[path.replace(/^\//, "")] ?? 0) + 1;
      }
    }
    return found;
  }

  it("has no sub-16px paragraph outside the frozen C3 debt", () => {
    expect(offenders()).toEqual(DEBT);
  });

  it("would catch a new one", () => {
    // Watched to fail: a paragraph at 13px with no label role on it.
    const line = '        <p className="font-sans text-[13px] text-ink3">Some running prose.</p>';
    expect(UNDER_16.test(line) && !LABEL_ROLES.some((r) => line.includes(r))).toBe(true);
    // And a 16px one, or a label, passes.
    expect(UNDER_16.test('<p className="text-[16px]">x</p>')).toBe(false);
    expect(LABEL_ROLES.some((r) => '<p className="text-[11px] uppercase">x</p>'.includes(r))).toBe(true);
  });
});
