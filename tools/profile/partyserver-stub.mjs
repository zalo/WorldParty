/** Minimal stand-in for `partyserver` so the server class can run in plain Node: a base class with the
 *  context/env/name/broadcast surface the room uses, and a router that matches nothing. */
export class Server {
    constructor(ctx, env) { this.ctx = ctx; this.env = env; }
    get name() { return this.ctx.id?.name ?? 'profile'; }
    broadcast() {}
    getConnection() { return undefined; }
    getConnections() { return []; }
}
export function routePartykitRequest() { return null; }
