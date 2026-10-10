// @extractus/article-extractor does not export its charset sniffing; the
// extractor uses it directly so a page decodes exactly as extract() decoded it.
declare module "@extractus/article-extractor/src/utils/html.js" {
  export function getCharset(html: string): string;
}
