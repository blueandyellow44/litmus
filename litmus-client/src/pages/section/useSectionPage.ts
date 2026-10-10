// The section page's data, shared by its desktop and mobile versions. Neither
// version fetches or derives anything itself; they only lay out the model this
// hook returns, so the two can never disagree about what a desk contains.

import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchSection, ApiHttpError } from "../../lib/api.ts";
import type { SectionPageDTO } from "../../lib/types.ts";
import { buildSectionModel, type SectionModel } from "./sectionModel.ts";

// The Reading-as lens is cut (story-first plan, ruling 6, 2026-09-17). Every
// caller below still takes a readingAs string rather than being rewired —
// see the note in StorySpread.tsx — so this is the one place "mixed" is
// pinned rather than read from a control.
const READING_AS = "mixed";

export type SectionPageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; model: SectionModel };

type Load = { data: SectionPageDTO | null; loading: boolean; error: string };

export function useSectionPage(): SectionPageState {
  const { slug } = useParams<{ slug: string }>();
  const [load, setLoad] = useState<Load>({ data: null, loading: true, error: "" });

  useEffect(() => {
    if (!slug) {
      setLoad({ data: null, loading: false, error: "Missing section" });
      return;
    }
    // A slow response for the section the reader just left must not overwrite
    // the one they navigated to.
    let cancelled = false;
    setLoad({ data: null, loading: true, error: "" });
    fetchSection(slug)
      .then((d) => {
        if (!cancelled) setLoad({ data: d, loading: false, error: "" });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof ApiHttpError && err.status === 404
            ? "That section does not exist."
            : err instanceof ApiHttpError
              ? err.message
              : String(err);
        setLoad({ data: null, loading: false, error: message });
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Memoized so child components (claim receipts) are not handed a fresh
  // array on every render.
  const model = useMemo(() => (load.data ? buildSectionModel(load.data, READING_AS) : null), [load.data]);

  if (load.loading) return { status: "loading" };
  if (load.error) return { status: "error", message: load.error };
  if (!model) return { status: "loading" };
  return { status: "ready", model };
}
