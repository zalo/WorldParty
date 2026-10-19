/** The vertex GI's worker (see giHost.js): the refined meshes, records, adaptive splits and scheduling, off the main
 *  thread. Built as its own bundle (tools/build-site.mjs) and started by TerrainGI. */
import { GIHost } from './giHost.js';

const host = new GIHost((msg, transfer) => postMessage(msg, transfer));
onmessage = (e) => host.handle(e.data);
