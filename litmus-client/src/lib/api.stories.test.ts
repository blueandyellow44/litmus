// The demo path of fetchStories and fetchStory. A snapshot without a story list
// is an edition built before the contract, and it must not read as a quiet day.

import { afterEach, describe, expect, it, vi } from "vitest";
import { member, story } from "./storyTestData.ts";

const s1 = story({ slug: "first", id: "st_1" });
const s2 = story({ slug: "second", id: "st_2" });
let demoSnapshot: Record<string, unknown> = {};

vi.mock("../demo/snapshot.json", () => ({ get default() { return demoSnapshot; } }));

async function loadApi() {
  vi.resetModules();
  vi.stubEnv("VITE_DEMO", "true");
  return import("./api.ts");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("fetchStories (demo)", () => {
  it("decodes HTML entities in the headline and every member title, not in excerpts", async () => {
    const m = member({ title: "&#039;Grandmother Tree&#039; Toppled" });
    demoSnapshot = { stories: [story({ headline: "AT&amp;T &#8217;s deal", members: [m] })] };
    const api = await loadApi();
    const [got] = await api.fetchStories();
    expect(got!.headline).toBe("AT&T \u2019s deal");
    expect(got!.members[0]!.title).toBe("'Grandmother Tree' Toppled");
  });
  it("decodes an excerpt and its marker text together, so highlights still match", async () => {
    const m = member({ excerpt: { paragraphs: ["Ben Shapiro&#8217;s latest foray"], markers: [{ text: "Shapiro&#8217;s latest", category: "loaded", intensity: 3 }] } });
    demoSnapshot = { stories: [story({ members: [m] })] };
    const api = await loadApi();
    const ex = (await api.fetchStories())[0]!.members[0]!.excerpt!;
    expect(ex.paragraphs[0]).toBe("Ben Shapiro\u2019s latest foray");
    expect(ex.paragraphs[0]).toContain(ex.markers[0]!.text);
  });
  it("returns the frozen list in its frozen order", async () => {
    demoSnapshot = { stories: [s1, s2] };
    const api = await loadApi();
    expect((await api.fetchStories()).map((s) => s.id)).toEqual(["st_1", "st_2"]);
  });
  it("throws no_story_list for a snapshot that predates the contract", async () => {
    demoSnapshot = { articles: [] };
    const api = await loadApi();
    await expect(api.fetchStories()).rejects.toMatchObject({ status: 404, code: "no_story_list" });
  });
  it("returns an empty list for a quiet edition", async () => {
    demoSnapshot = { stories: [] };
    const api = await loadApi();
    expect(await api.fetchStories()).toEqual([]);
  });
});

describe("fetchStory (demo)", () => {
  it("finds a story by slug or by id", async () => {
    demoSnapshot = { stories: [s1, s2] };
    const api = await loadApi();
    expect((await api.fetchStory("second")).id).toBe("st_2");
    expect((await api.fetchStory("st_1")).slug).toBe("first");
  });
  it("404s with unknown_story otherwise", async () => {
    demoSnapshot = { stories: [s1] };
    const api = await loadApi();
    await expect(api.fetchStory("nope")).rejects.toMatchObject({ status: 404, code: "unknown_story" });
  });
});
