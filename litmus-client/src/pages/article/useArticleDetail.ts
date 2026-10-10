// The article page's data, shared by its desktop and mobile versions. Neither
// version fetches or derives anything itself; they only lay out what this hook
// returns.

import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchArticle, ApiHttpError } from "../../lib/api.ts";
import type { ArticleDetailDTO } from "../../lib/types.ts";
import { ARTICLE_COPY, articleView, parseArticleId, type ArticleView } from "./articleView.ts";

export type ArticleDetailState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; view: ArticleView };

// What the last finished load was for. Keyed by id, so moving from one article
// to another shows "Loading" rather than the previous article under the new URL.
type Settled = { id: number; article: ArticleDetailDTO } | { id: number; message: string };

export function useArticleDetail(): ArticleDetailState {
  const { id } = useParams<{ id: string }>();
  const articleId = parseArticleId(id);
  const [settled, setSettled] = useState<Settled | null>(null);

  useEffect(() => {
    if (articleId === null) return;
    let cancelled = false;
    fetchArticle(articleId)
      .then((article) => {
        if (!cancelled) setSettled({ id: articleId, article });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setSettled({ id: articleId, message: err instanceof ApiHttpError ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [articleId]);

  if (articleId === null) return { status: "error", message: ARTICLE_COPY.invalidId };
  if (!settled || settled.id !== articleId) return { status: "loading" };
  if ("message" in settled) return { status: "error", message: settled.message };
  return { status: "ready", view: articleView(settled.article) };
}
