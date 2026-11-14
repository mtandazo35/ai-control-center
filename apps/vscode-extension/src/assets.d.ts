/** Files from media/ embedded at build time (esbuild plugin in esbuild.mjs; Vite alias in vitest.config.ts). */
declare module 'asset:*' {
  const content: string;
  export default content;
}
