/// <reference types="vite/client" />

/** CSS is imported for its side effects only. */
declare module '*.css';

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly VITE_TITAN_SERVER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
