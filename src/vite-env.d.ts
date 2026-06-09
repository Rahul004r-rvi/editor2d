/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MULTISET_API_URL?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_NAVME_POI_TYPE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
