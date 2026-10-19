/** Assemble the static site in public/: index.html, assets/ (models, textures, worlds, vendored WASM) and the
 *  bundled client. Used by `npm run build` (once) and tools/dev.mjs (watch). */
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function buildSite({ watch = false, host = process.env.SERVER_HOST || 'worldparty.makeshifted.workers.dev' } = {}) {
    rmSync('public', { recursive: true, force: true });
    mkdirSync('public', { recursive: true });
    for(let page of ['index.html', 'terms.html', 'privacy.html']) cpSync(page, 'public/' + page); // the legal pages are what Discord's app verification links to
    cpSync('assets', 'public/assets', { recursive: true });
    let options = {
        entryPoints: { main: 'src/main.js', giWorker: 'src/client/giWorker.js' }, bundle: true, format: 'esm', outdir: 'public/dist', // the vertex GI's worker is its own bundle, next to main.js
        minify: !watch, sourcemap: true, logLevel: 'info',
        define: { PARTYKIT_HOST: JSON.stringify(host) }, // fallback host when the page is not served over http(s)
    };
    if(!watch) return build(options);
    let ctx = await context(options);
    await ctx.watch();
    return ctx;
}

if(process.argv[1] === fileURLToPath(import.meta.url)) await buildSite();
