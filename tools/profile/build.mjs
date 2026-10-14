/** Bundle the PartyKit server for Node with the real WASM modules, so a carve can be profiled
 *  without a browser or the dev server. Output: tools/profile/server.bundle.mjs */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const wasmAsModule = {
    name: 'wasm-as-module',
    setup(b) {
        b.onResolve({ filter: /\.wasm$/ }, args => ({ path: path.resolve(args.resolveDir, args.path), namespace: 'wasm-module' }));
        b.onLoad({ filter: /.*/, namespace: 'wasm-module' }, args => ({
            contents: `import { readFileSync } from 'node:fs'; export default new WebAssembly.Module(readFileSync(${JSON.stringify(args.path)}));`,
            loader: 'js', resolveDir: path.dirname(args.path),
        }));
    },
};

await build({
    entryPoints: ['src/server.js'],
    bundle: true, format: 'esm', platform: 'node', target: 'node22',
    outfile: 'tools/profile/server.bundle.mjs',
    plugins: [wasmAsModule],
    external: ['partykit/server'],
    mainFields: ['module', 'main'], conditions: ['import', 'module'],
    logLevel: 'warning',
});
