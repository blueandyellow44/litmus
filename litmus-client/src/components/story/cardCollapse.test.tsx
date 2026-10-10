// The collapsed front-page card (Max, 2026-10-02): chart and extremes on
// show, the per-outlet evidence and the chart's table behind one control. A
// two-outlet story keeps the chart like every other card (Max, 2026-10-05).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StoryWireItemDesktop, StoryWireItemMobile, storyAnchor } from "./StoryWireItem.tsx";
import { member, story } from "../../lib/storyTestData.ts";

const ex = { paragraphs: ["The outlet said the vote was a brazen assault on the rules."], markers: [{ text: "a brazen assault", category: "loaded_terms", intensity: 4 }] };
const three = story({ members: [
  member({ outletKey: "a", outletName: "Alpha", composite: 1.6, excerpt: ex, howItWasTold: "A plain headline and neutral language." }),
  member({ outletKey: "b", outletName: "Beta", composite: 2.4, excerpt: ex }),
  member({ outletKey: "c", outletName: "Gamma", composite: 3.6, excerpt: ex }),
] });
const two = story({ members: three.members.slice(0, 2) });

for (const [name, Card] of [["desktop", StoryWireItemDesktop], ["mobile", StoryWireItemMobile]] as const) {
  describe(`collapsed card, ${name}`, () => {
    it("opens collapsed: the control, the chart, no per-outlet evidence and no table", () => {
      const out = renderToStaticMarkup(<Card story={three} />);
      expect(out).toContain("Show the 3 tellings");
      expect(out).toContain('aria-expanded="false"');
      expect(out).toContain("<svg");
      expect(out).not.toContain("A plain headline and neutral language.");
      expect(out).not.toContain("<table");
    });
    it("links the headline to the story's own anchor", () => {
      const out = renderToStaticMarkup(<Card story={three} />);
      expect(out).toContain(`id="${storyAnchor(three)}"`);
      expect(out).toContain(`href="#${storyAnchor(three)}"`);
    });
    it("keeps the chart for a two-outlet story", () => {
      const out = renderToStaticMarkup(<Card story={two} />);
      expect(out).toContain("<svg");
      expect(out).toContain("Show the 2 tellings");
    });
  });
}
