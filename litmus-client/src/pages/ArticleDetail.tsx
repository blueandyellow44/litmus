// Article detail: the score, the facts summary, the capped excerpt with its
// highlights, and a link out to the original. LITMUS ships a dedicated desktop
// version and a dedicated mobile version of every page (standing rule, Max
// 2026-09-13), so this only chooses between them; both read the same article
// through article/useArticleDetail.ts and article/articleView.ts.
//
// Legal posture (the excerpt policy): the published paper never carries an
// article's full body. The snapshot strips rawText and full-article
// translations before it is written, and the publish gate refuses an edition
// that still carries either. Neither version therefore has a "read the full
// article" view or a full-article translation view; the reader goes to the
// outlet for the whole piece.
//
// The private `leanText` that used to live here is gone. It was a fourth copy of
// the -100..+100 bucketing, and worse, its output was rendered as "Leans:
// Center-Left" beside an unlabelled `sourceLean` in the meta line above — so the
// detail page printed BOTH political readings, gave neither of them a name, and
// spelled its buckets differently from every other surface ("Center-Left" here,
// "Center-left" everywhere else). `framingLabel` in components/meta.tsx is the
// one implementation, and `ArticleFraming` is the only thing that renders it.

import { useDevice } from "../lib/device.tsx";
import { ArticleDetailDesktop } from "./article/ArticleDetailDesktop.tsx";
import { ArticleDetailMobile } from "./article/ArticleDetailMobile.tsx";

export function ArticleDetail() {
  const { device } = useDevice();
  return device === "mobile" ? <ArticleDetailMobile /> : <ArticleDetailDesktop />;
}
