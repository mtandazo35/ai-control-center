import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

/** Same `asset:` imports as esbuild.mjs: text for js/css, base64 for binaries. */
const assets = {
  name: 'asset',
  enforce: 'pre' as const,
  resolveId(id: string) {
    return id.startsWith('asset:') ? `\0asset:${id.slice(6)}` : null;
  },
  load(id: string) {
    if (!id.startsWith('\0asset:')) return null;
    const file = path.resolve(__dirname, 'media', id.slice(7));
    const data = fs.readFileSync(file);
    const s = /\.(png|ico)$/.test(file) ? data.toString('base64') : data.toString('utf8');
    return `export default ${JSON.stringify(s)};`;
  },
};

export default defineConfig({
  plugins: [assets],
  test: { include: ['test/**/*.test.ts'], environment: 'node', testTimeout: 20000 },
});
