/** Rewrite the minimum (initial) size of a WASM module's memory section in place.
 *  node tools/patch-wasm-memory.mjs assets/physx/physx-js-webidl.wasm 256
 *  The PhysX build ships with 64 MB of initial memory; a Durable Object has 128 MB in total, and the heap
 *  can grow on demand, so a smaller start leaves room for everything else. The module's static data and
 *  stack (well under 1 MB here) must fit in the new minimum. */
import { readFileSync, writeFileSync } from 'node:fs';
let [file, minPagesArg] = process.argv.slice(2);
let minPages = parseInt(minPagesArg);
let data = readFileSync(file);
if(data.readUInt32LE(0) !== 0x6d736100) throw new Error('not a wasm file');
const leb = (p) => { let r = 0, sh = 0, b; do { b = data[p++]; r |= (b & 0x7f) << sh; sh += 7; } while(b & 0x80); return [r, p]; };
const encode = (n) => { let out = []; do { let b = n & 0x7f; n >>>= 7; if(n) b |= 0x80; out.push(b); } while(n); return Buffer.from(out); };
let pos = 8;
while(pos < data.length) {
    let id = data[pos], sizePos = pos + 1, [size, start] = leb(sizePos);
    if(id === 5) {
        let [count, p] = leb(start); if(count !== 1) throw new Error('expected one memory');
        let flags = data[p]; let [oldMin, afterMin] = leb(p + 1);
        let rest = data.subarray(afterMin, start + size); // maximum, if any
        let body = Buffer.concat([encode(1), Buffer.from([flags]), encode(minPages), rest]);
        let out = Buffer.concat([data.subarray(0, sizePos), encode(body.length), body, data.subarray(start + size)]);
        writeFileSync(file, out);
        console.log(`${file}: memory min ${oldMin} pages (${oldMin / 16} MB) -> ${minPages} pages (${minPages / 16} MB), flags ${flags}`);
        process.exit(0);
    }
    pos = start + size;
}
throw new Error('no memory section');
