import * as esbuild from 'esbuild';
import * as path from 'node:path';

/** `import x from 'asset:name'` embeds media/<name>: text for js/css, base64 for binaries. */
const assetPlugin = {
  name: 'asset',
  setup(build) {
    // A relative path: the bundle keeps it as a comment, and an absolute one would leak the builder's home folder.
    build.onResolve({ filter: /^asset:/ }, (args) => ({
      path: 'media/' + args.path.slice('asset:'.length),
      namespace: 'asset',
    }));
    build.onLoad({ filter: /.*/, namespace: 'asset' }, async (args) => {
      const fs = await import('node:fs');
      const file = path.resolve(args.path);
      const binary = /\.(png|ico)$/.test(file);
      return { contents: fs.readFileSync(file), loader: binary ? 'base64' : 'text', watchFiles: [file] };
    });
  },
};

const watch = process.argv.includes('--watch');
const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', sourcemap: false, minify: false, logLevel: 'info', plugins: [assetPlugin] };
const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  { ...common, entryPoints: ['src/agent.ts'], outfile: 'dist/agent.js', banner: { js: '#!/usr/bin/env node' } },
];
if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
