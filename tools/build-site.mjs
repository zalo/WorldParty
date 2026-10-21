/** Assemble the static site in public/: index.html, assets/ (models, textures, worlds, vendored WASM) and the
 *  bundled client. Used by `npm run build` (once) and tools/dev.mjs (watch). */
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Singleplayer's room server (src/solo/serverWorker.js) is src/server.js bundled for a browser worker: `partyserver`'s
 *  Durable Object base class is swapped for src/solo/partyserver.js, and a WASM module, which the Workers bundler
 *  imports compiled, is fetched from public/assets/ next to the bundle and compiled before the server starts. */
const solo = {
    name: 'solo',
    setup(b) {
        b.onResolve({ filter: /^partyserver$/ }, () => ({ path: path.resolve('src/solo/partyserver.js') }));
        b.onResolve({ filter: /\.wasm$/ }, (args) => ({ path: path.resolve(args.resolveDir, args.path), namespace: 'solo-wasm' }));
        b.onLoad({ filter: /.*/, namespace: 'solo-wasm' }, (args) => {
            let url = '../' + path.relative('.', args.path).split(path.sep).join('/'); // assets/x.wasm, from public/dist/
            return { contents: `export default await WebAssembly.compile(await (await fetch(new URL(${JSON.stringify(url)}, import.meta.url))).arrayBuffer());`, loader: 'js' };
        });
    },
};

export async function buildSite({ watch = false, host = process.env.SERVER_HOST || 'worldparty.makeshifted.workers.dev' } = {}) {
    rmSync('public', { recursive: true, force: true });
    mkdirSync('public', { recursive: true });
    for(let page of ['index.html', 'terms.html', 'privacy.html']) cpSync(page, 'public/' + page); // the legal pages are what Discord's app verification links to
    cpSync('assets', 'public/assets', { recursive: true });
    let options = {
        // the vertex GI's worker and singleplayer's room server are bundles of their own, next to main.js
        entryPoints: { main: 'src/main.js', giWorker: 'src/client/giWorker.js', soloServer: 'src/solo/serverWorker.js' }, bundle: true, format: 'esm', outdir: 'public/dist',
        minify: !watch, sourcemap: true, logLevel: 'info',
        define: { PARTYKIT_HOST: JSON.stringify(host) }, // fallback host when the page is not served over http(s)
        plugins: [solo],
    };
    if(!watch) return build(options);
    let ctx = await context(options);
    await ctx.watch();
    return ctx;
}

if(process.argv[1] === fileURLToPath(import.meta.url)) await buildSite();
