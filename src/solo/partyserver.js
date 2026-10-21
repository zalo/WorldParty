/** Singleplayer (src/solo/): what the room server (src/server.js) uses of `partyserver`, so the same class runs in a Web
 *  Worker on this machine instead of as a Durable Object. The connections are the worker's (serverWorker.js); the
 *  bundler resolves `partyserver` here for that bundle only (tools/build-site.mjs). */
export class Server {
    constructor(ctx, env) { this.ctx = ctx; this.env = env; }
    get name() { return this.ctx.id.name; }
    broadcast(msg, without = []) { for(let c of this.ctx.connections.values()) if(!without.includes(c.id)) c.send(msg); }
    getConnection(id) { return this.ctx.connections.get(id); }
    getConnections() { return this.ctx.connections.values(); }
}
export function routePartykitRequest() { return null; }
