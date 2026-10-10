/// <reference types="vite/client" />

interface ImportMetaEnv {
  // "true" builds a frozen-snapshot demo that runs with no backend (Cloudflare
  // Pages). Unset/other builds hit the live API.
  readonly VITE_DEMO?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
