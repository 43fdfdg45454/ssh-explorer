// Build script: bundles the extension into dist/extension.js (CommonJS, Node).
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Marks native addons as external so ssh2 falls back to its pure-JS code paths. */
const nativeAddonsExternal = {
  name: 'native-addons-external',
  setup(build) {
    build.onResolve({ filter: /\.node$/ }, (args) => ({ path: args.path, external: true }));
  },
};

/** Prints esbuild problems in a format the VS Code task problem matcher understands. */
const problemMatcher = {
  name: 'esbuild-problem-matcher',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) console.error(`    ${location.file}:${location.line}:${location.column}:`);
      }
      console.log('[watch] build finished');
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode', 'cpu-features'],
  sourcemap: production ? false : 'linked',
  minify: production,
  keepNames: true,
  sourcesContent: false,
  logLevel: 'silent',
  define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') },
  plugins: [nativeAddonsExternal, problemMatcher],
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
