/** Local development: esbuild watches the client bundle into public/ while wrangler serves the Worker,
 *  the Durable Objects and the static site. Equivalent to the old `partykit dev --live`. */
import { spawn } from 'node:child_process';
import { buildSite } from './build-site.mjs';

await buildSite({ watch: true });
let port = process.env.PORT || '1999';
let wrangler = spawn('npx', ['wrangler', 'dev', '--port', port, '--ip', '0.0.0.0', ...process.argv.slice(2)], { stdio: 'inherit' });
wrangler.on('exit', code => process.exit(code ?? 0));
for(let sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => wrangler.kill(sig));
