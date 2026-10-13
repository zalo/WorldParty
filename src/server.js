/* eslint-env browser */
// @ts-check
/** @typedef {import("partykit/server").Room} Room */
/** @typedef {import("partykit/server").Server} Server */
/** @typedef {import("partykit/server").Connection} Connection */
/** @typedef {import("partykit/server").ConnectionContext} ConnectionContext */

import { World } from './ecs/World.js';
import { Transform, RigidBody, Prop, Joint, Grabbed, Player, Model, PERSISTED } from './ecs/components.js';
import { Physics } from './server/Physics.js';
import { Terrain, chunkCenter } from './server/Terrain.js';
import { Connectivity, DUST_VOLUME, MAX_FRAGMENT_VOLUME } from './server/Connectivity.js';
import { chunkAt, key as chunkKey, isValidKey, sanitizeWorld, DEFAULT_WORLD } from './terrain/grid.js';
import { getPropDef } from './props/PropRegistry.js';
import { packChunkFrame } from './net/codec.js';

const TICK_MS = 1000 / 30;
const FULL_UPDATE_EVERY = 300;      // ticks (10s)
const PERSIST_INTERVAL_MS = 5000;
const STORAGE_BATCH = 128;          // Durable Object storage batch limit
const STORAGE_PART = 100 * 1024;    // chunk bytes above this are split across chunkpart:<key>:<i> values (128 KiB value limit)

const PLAYER_COLORS = ["#FF0000", "#0000FF", "#FFFF00", "#FF00FF", "#00FFFF", "#FF8000", "#FF0080", "#8000FF", "#0080FF", "#80FF00", "#00FF80", "#FF8080", "#8080FF", "#FF80FF", "#80FFFF", "#FFFF80"];

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v)) ? v : d;
const vec3 = (v, d = { x: 0, y: 0, z: 0 }) => v ? { x: num(v.x, d.x), y: num(v.y, d.y), z: num(v.z, d.z) } : { ...d };
const quat = (q) => q ? { x: num(q.x), y: num(q.y), z: num(q.z), w: num(q.w, 1) } : { x: 0, y: 0, z: 0, w: 1 };

/** @implements {Server} */
class PartyServer {
  /** @param {Room} room */
  constructor(room) {
    this.room = room;
    this.world = new World();
    this.physics = new Physics();
    this.terrain = new Terrain();
    this.connectivity = new Connectivity(this.terrain);
    this.chunkStates = new Map();   // key -> what clients should hold, see Connectivity.states()
    this.sentStates = new Map();    // key -> last wire state broadcast
    this.chunkDelta = null;         // pending {chunks, rock, cull} for the next partial update
    this.occupiedKey = '';          // chunks containing players/bodies, for cheap change detection
    this.activeRoots = new Set();
    this.colliderState = new Map(); // key -> 'box' | 'mesh:<version>'
    this.persistChunkDeletes = new Set();
    this.chunkParts = new Map();    // key -> number of chunkpart values currently stored
    this.ready = false;
    this.readyPromise = new Promise(res => { this.resolveReady = res; });
    this.globalPlayerCount = 0;
    this.tickCount = 0;
    this.serverTickMs = 0;
    this.anyAwake = false;

    // Persistence queue: entity ids whose persisted components changed
    this.persistQueue = new Set();
    this.persistRemoved = new Set();
    this.world.on('set', (id, name) => { if(PERSISTED.has(name) && !this.world.has(id, 'Player')) this.persistQueue.add(id); });
    this.world.on('remove', (id, name) => { if(PERSISTED.has(name) && !this.world.has(id, 'Player')) this.persistQueue.add(id); });
    this.world.on('destroy', (id) => { this.persistQueue.delete(id); this.persistRemoved.add(id); });
    this.lastPersist = Date.now();

    this.physics.attach(this.world);
    this.interval = setInterval(() => this.tick(), TICK_MS);
  }

  // ---- lifecycle ----------------------------------------------------------

  async onStart() {
    let [storedChunks, storedEntities, storedWorld] = await Promise.all([this.loadPrefixed('chunk:'), this.loadPrefixed('ent:'), this.room.storage.get('world')]);
    await this.joinChunkParts(storedChunks);

    // Legacy single-blob layout
    let legacyChunks = await this.room.storage.get("chunks");
    if(legacyChunks) { Object.assign(storedChunks, legacyChunks); await this.room.storage.delete("chunks"); }
    // Legacy numeric chunk indices (x*100+y*10+z over a 10^3 grid centred on the origin) -> "x,y,z" keys
    for(let k of Object.keys(storedChunks)) {
      if(!/^\d+$/.test(k)) continue;
      let i = parseInt(k), nk = chunkKey(Math.floor(i / 100) - 5, Math.floor(i / 10) % 10 - 5, i % 10 - 5);
      storedChunks[nk] = { ...storedChunks[k], key: nk };
      delete storedChunks[k];
      this.persistChunkDeletes.add(k);
      this.markChunkPersist(nk);
    }

    await this.terrain.init(storedChunks, storedWorld);
    await this.physics.init();

    let maxId = 0;
    for(let id in storedEntities) {
      this.world.create(id, storedEntities[id]);
      let m = /^e(\d+)$/.exec(id); if(m) maxId = Math.max(maxId, parseInt(m[1]));
    }
    this.world.nextId = maxId + 1;
    this.world.takeDirty(); // loaded state is not "changed"
    this.persistQueue.clear(); this.persistRemoved.clear();
    // Chunks loaded from the legacy soup format are re-encoded and flagged for re-persist
    for(let k in this.terrain.takeDirty()) this.markChunkPersist(k);
    // Ground check with the current algorithm: anything unsupported falls now
    let shed = this.settleTerrain();
    for(let k in this.terrain.takeDirty()) this.markChunkPersist(k);
    this.refreshActivity(true);
    this.ready = true;
    this.resolveReady();
    console.log(`World ready: ${Object.keys(storedChunks).length} chunks, ${Object.keys(storedEntities).length} entities, ${shed} fragment(s) shed, ${Object.keys(this.physics.chunkActors).length} chunk colliders`);
  }

  async loadPrefixed(prefix) {
    let out = {};
    let map = await this.room.storage.list({ prefix });
    for(let [key, value] of map) out[key.slice(prefix.length)] = value;
    return out;
  }

  /** Chunk records whose bytes were split into parts get them joined back. */
  async joinChunkParts(storedChunks) {
    let parts = await this.room.storage.list({ prefix: 'chunkpart:' });
    for(let k in storedChunks) {
      let c = storedChunks[k];
      if(!c || !c.parts) continue;
      this.chunkParts.set(k, c.parts);
      let total = 0, slices = [];
      for(let i = 0; i < c.parts; i++) { let p = parts.get(`chunkpart:${k}:${i}`); if(!p) { slices = null; break; } slices.push(p); total += p.byteLength; }
      if(!slices) { console.warn(`chunk ${k}: missing parts, dropped`); delete storedChunks[k]; continue; }
      let bytes = new Uint8Array(total), o = 0;
      for(let p of slices) { bytes.set(new Uint8Array(p.buffer || p, p.byteOffset || 0, p.byteLength), o); o += p.byteLength; }
      storedChunks[k] = { key: k, version: c.version, bytes };
    }
  }

  // ---- terrain connectivity ------------------------------------------------

  /** Solve connectivity and turn every unsupported solid into fragment entities. Returns the number made. */
  settleTerrain() {
    let made = 0;
    for(let pass = 0; pass < 4; pass++) {
      this.connectivity.solve();
      let floating = this.connectivity.floatingComponents();
      if(!floating.length) break;
      let touched = new Map(); // key -> Set of island k removed
      for(let comp of floating) {
        if(comp.volume > MAX_FRAGMENT_VOLUME) { console.log(`Keeping unsupported terrain of volume ${comp.volume.toFixed(0)} (too large to drop)`); continue; }
        for(let { key, k } of comp.islands) { if(!touched.has(key)) touched.set(key, new Set()); touched.get(key).add(k); }
        if(comp.volume < DUST_VOLUME) continue;
        let M = this.terrain.manifold.Manifold;
        let pieces = comp.islands.map(({ key, island }) => island.manifold || this.terrain.rockManifold(key));
        let merged = pieces.length === 1 ? M.compose([pieces[0]]) : M.union(pieces);
        for(let i = 0; i < pieces.length; i++) if(!comp.islands[i].island.manifold) pieces[i].delete(); // materialized rock copies
        let comps = this.terrain.fragmentComponents(merged);
        merged.delete();
        if(comps) { this.world.create(comps); made++; }
      }
      // Rebuild each touched chunk from the islands that stay
      for(let [key, removed] of touched) {
        let S = this.connectivity.summary(key);
        let keep = S.solid.filter((_, k) => !removed.has(k)).map(s => s.manifold);
        this.terrain.setManifold(key, keep.length ? this.terrain.manifold.Manifold.compose(keep) : null);
      }
      // Removing solid can merge hollows, so solve again; normally nothing is left floating.
    }
    return made;
  }

  /** Chunks containing a player or a body, as a sorted key for change detection. */
  occupiedChunks() {
    let set = new Set();
    for(let [id, tf] of this.world.each('Transform')) {
      if(this.world.has(id, 'Player') || this.world.has(id, 'RigidBody')) set.add(chunkAt(this.terrain.world, tf.position));
    }
    return set;
  }

  /** Recompute which hollows are active and what every chunk should materialize; queue the diff for clients. */
  refreshActivity(force = false) {
    if(this.importing) return; // the world is being replaced; importEnd solves and refreshes once
    let occupied = this.occupiedChunks();
    let key = [...occupied].sort().join(';');
    if(!force && key === this.occupiedKey) return;
    this.occupiedKey = key;
    let roots = this.connectivity.activeRoots(occupied);
    if(!force && roots.size === this.activeRoots.size && [...roots].every(r => this.activeRoots.has(r))) return;
    this.activeRoots = roots;
    this.chunkStates = this.connectivity.states(roots);
    this.syncColliders();
    this.queueChunkDelta();
  }

  syncColliders() {
    for(let key of new Set([...this.chunkStates.keys(), ...this.colliderState.keys()])) {
      let st = this.chunkStates.get(key);
      let want = !st ? undefined : st.mask !== undefined ? 'box' : 'mesh:' + this.terrain.chunks[key].version;
      if(want === this.colliderState.get(key)) continue;
      if(want) this.colliderState.set(key, want); else this.colliderState.delete(key);
      if(!want) this.physics._removeChunkActor(key);
      else if(want === 'box') { let c = chunkCenter(key); this.physics.setDefaultChunkCollider(key, c.x, c.y, c.z); }
      else this.physics.setChunkCollider(key, this.terrain.chunkMesh(key));
    }
  }

  /** What a client should hold for a chunk: {version, cull} for a modified chunk, {rock} for rock faces, null for nothing. */
  wireState(key) {
    let st = this.chunkStates.get(key);
    if(!st) return null;
    if(st.mask !== undefined) return { rock: st.mask };
    return { version: this.terrain.chunks[key].version, cull: st.cull };
  }

  /** Diff wire states against what was last sent and merge into the pending delta. */
  queueChunkDelta() {
    let delta = this.chunkDelta || { chunks: {}, rock: {}, cull: {} };
    let any = false;
    for(let key of new Set([...this.chunkStates.keys(), ...this.sentStates.keys()])) {
      let now = this.wireState(key), was = this.sentStates.get(key) || null;
      if(JSON.stringify(now) === JSON.stringify(was)) continue;
      any = true;
      if(now) this.sentStates.set(key, now); else this.sentStates.delete(key);
      if(now && now.version !== undefined) {
        if(!was || was.version !== now.version) delta.chunks[key] = now.version;
        if(!was || was.cull !== now.cull) delta.cull[key] = now.cull;
        if(was && was.rock !== undefined) delta.rock[key] = 0;
      } else if(now) {
        delta.rock[key] = now.rock;
        if(was && was.version !== undefined) delta.chunks[key] = null;
      } else {
        if(was.version !== undefined) delta.chunks[key] = null;
        else delta.rock[key] = 0;
      }
    }
    if(any) this.chunkDelta = delta;
  }

  /** Full wire maps for a full update. */
  chunkMaps() {
    let chunks = {}, rock = {}, cull = {};
    for(let [key, st] of this.sentStates) {
      if(st.version !== undefined) { chunks[key] = st.version; cull[key] = st.cull; }
      else rock[key] = st.rock;
    }
    return { chunks, rock, cull };
  }

  /** @param {Connection} conn @param {ConnectionContext} ctx */
  onConnect(conn, ctx) {
    this.globalPlayerCount += 1;
    this.world.create(conn.id, {
      Player: Player({ name: "Player " + this.globalPlayerCount, color: PLAYER_COLORS[this.globalPlayerCount % PLAYER_COLORS.length] }),
      Transform: Transform(),
    });
    conn.send(JSON.stringify(this.fullUpdate()));
    console.log(`Connected: ${conn.id} room: ${this.room.id} url: ${new URL(ctx.request.url).pathname}`);
  }

  /** @param {Connection} conn */
  async onDisconnect(conn) {
    if(!this.world.has(conn.id)) return;
    // Drop anything this player was holding, then the player itself
    for(let [id, g] of this.world.each('Grabbed')) if(g.by === conn.id) this.world.remove(id, 'Grabbed');
    this.world.destroy(conn.id);
    await this.persist();
  }
  onClose(conn) { this.onDisconnect(conn); }
  onError(conn, error) { console.error(error); this.onDisconnect(conn); }

  // ---- tick ---------------------------------------------------------------

  tick() {
    if(!this.ready) return;
    let start = Date.now();
    let players = this.world.query('Player').size;

    // Nothing to simulate: no players and everything asleep
    if(players === 0 && !this.anyAwake && !this.world.hasDirty() && !this.chunkDelta) {
      this.physics.lastTime = start;
      return;
    }

    this.anyAwake = this.physics.update(this.world, TICK_MS / 1000);
    this.tickCount++;
    this.refreshActivity();

    if(players > 0) {
      if(this.tickCount % FULL_UPDATE_EVERY === 0) {
        this.room.broadcast(JSON.stringify(this.fullUpdate()));
        this.world.takeDirty(); this.chunkDelta = null;
      } else if(this.world.hasDirty() || this.chunkDelta) {
        let { entities, removed } = this.world.takeDirty();
        let d = this.chunkDelta || {};
        this.chunkDelta = null;
        this.room.broadcast(JSON.stringify({ type: "partialupdate", entities, removed, chunks: d.chunks, rock: d.rock, cull: d.cull, serverTickMs: this.serverTickMs }));
      }
    }

    if(start - this.lastPersist > PERSIST_INTERVAL_MS) this.persist();
    this.serverTickMs = Date.now() - start;
  }

  fullUpdate() {
    return { type: "fullupdate", entities: this.world.serialize(), removed: [], world: this.terrain.world, ...this.chunkMaps(), serverTickMs: this.serverTickMs };
  }

  // ---- persistence (per-entity / per-chunk keys) --------------------------

  async persist() {
    this.lastPersist = Date.now();
    let puts = {};
    for(let id of this.persistQueue) {
      if(!this.world.has(id) || this.world.has(id, 'Player')) continue;
      let s = this.world.serializeEntity(id, (_, name) => PERSISTED.has(name));
      if(s && Object.keys(s).length > 0) puts['ent:' + id] = s;
    }
    let deletes = [...this.persistRemoved].map(id => 'ent:' + id);
    for(let key of this.persistChunks || []) {
      let c = this.terrain.serializeChunk(key);
      let oldParts = this.chunkParts.get(key) || 0;
      if(!c) { deletes.push('chunk:' + key); for(let i = 0; i < oldParts; i++) deletes.push(`chunkpart:${key}:${i}`); this.chunkParts.delete(key); continue; }
      let n = c.bytes && c.bytes.length > STORAGE_PART ? Math.ceil(c.bytes.length / STORAGE_PART) : 0;
      if(n) {
        puts['chunk:' + key] = { key, version: c.version, parts: n };
        for(let i = 0; i < n; i++) puts[`chunkpart:${key}:${i}`] = c.bytes.slice(i * STORAGE_PART, (i + 1) * STORAGE_PART);
      } else puts['chunk:' + key] = c;
      for(let i = n; i < oldParts; i++) deletes.push(`chunkpart:${key}:${i}`);
      this.chunkParts.set(key, n);
    }
    for(let key of this.persistChunkDeletes) deletes.push('chunk:' + key);
    this.persistQueue.clear(); this.persistRemoved.clear(); this.persistChunks = new Set(); this.persistChunkDeletes = new Set();

    let keys = Object.keys(puts);
    for(let i = 0; i < keys.length; i += STORAGE_BATCH) {
      let batch = {};
      for(let k of keys.slice(i, i + STORAGE_BATCH)) batch[k] = puts[k];
      await this.room.storage.put(batch);
    }
    for(let i = 0; i < deletes.length; i += STORAGE_BATCH) await this.room.storage.delete(deletes.slice(i, i + STORAGE_BATCH));
  }

  markChunkPersist(key) { (this.persistChunks ||= new Set()).add(key); }

  // ---- gameplay helpers ---------------------------------------------------

  spawnProp(propId, position, quaternion) {
    let def = getPropDef(propId);
    return this.world.create({
      Transform: Transform({ position, quaternion }),
      RigidBody: RigidBody({ shape: def.shape, halfExtent: def.halfExtent, propId: def.id }),
      Prop: Prop({ propId: def.id, url: def.url }),
    });
  }

  applyCsg(data) {
    this.terrain.applyCsg(data);
    if(this.terrain.dirty.size === 0) return;
    let t0 = Date.now();
    let fragments = this.settleTerrain();
    this.refreshActivity(true);
    let settleMs = Date.now() - t0;
    let changed = this.terrain.takeDirty();
    for(let key in changed) {
      this.markChunkPersist(key);
      // Push the new bytes to everyone who should hold this chunk now; later joiners fetch by version over HTTP.
      let st = this.sentStates.get(key), c = this.terrain.chunks[key];
      if(st && st.version !== undefined && c.bytes) this.room.broadcast(packChunkFrame(key, c.version, c.bytes));
    }
    console.log(`csg: ${Object.keys(changed).length} chunk(s) changed, ${fragments} fragment(s), ${Object.keys(this.physics.chunkActors).length} chunk colliders, settle ${settleMs}ms`);
  }

  /** HTTP: GET /parties/main/<room>/chunk/<x,y,z>?v=<version> -> chunk bytes (204 if empty). */
  async onRequest(req) {
    await this.readyPromise;
    let url = new URL(req.url);
    let m = /\/chunk\/(-?\d+,-?\d+,-?\d+)$/.exec(decodeURIComponent(url.pathname));
    if((req.method !== "GET" && req.method !== "HEAD") || !m) return new Response("Not found", { status: 404 });
    let key = m[1];
    if(!isValidKey(key)) return new Response("Bad chunk", { status: 400 });
    let c = this.terrain.chunks[key];
    if(!c) return new Response("Implicit chunk", { status: 404 });
    let headers = { "X-Chunk-Version": c.version, "Access-Control-Allow-Origin": "*" };
    // A URL that names the exact current version may be cached forever
    headers["Cache-Control"] = url.searchParams.get("v") === c.version ? "public, max-age=31536000, immutable" : "no-store";
    if(!c.bytes) return new Response(null, { status: 204, headers });
    headers["Content-Type"] = "application/octet-stream";
    return new Response(c.bytes, { status: 200, headers });
  }

  createJoint(data) {
    let w = this.world;
    let a = data.bodyIdA, b = data.bodyIdB;
    if(!w.has(a, 'RigidBody') || !w.has(b, 'RigidBody') || a === b) return;
    let pA = w.get(a, 'Transform').position, pB = w.get(b, 'Transform').position;
    let wA = vec3(data.worldPosA, pA), wB = vec3(data.worldPosB, pB);
    w.create({
      Joint: Joint({
        type: data.jointType, bodyA: a, bodyB: b,
        localOffsetA: { x: wA.x - pA.x, y: wA.y - pA.y, z: wA.z - pA.z },
        localOffsetB: { x: wB.x - pB.x, y: wB.y - pB.y, z: wB.z - pB.z },
        axis: data.axis ? vec3(data.axis, { x: 0, y: 1, z: 0 }) : null,
      })
    });
  }

  releaseHold(playerId, bodyId) {
    let g = this.world.get(bodyId, 'Grabbed');
    if(g && g.by === playerId) this.world.remove(bodyId, 'Grabbed');
  }

  /** Wipe terrain, entities and their storage; the world config becomes `world` (default: the sandbox). */
  async clearWorld(world = DEFAULT_WORLD) {
    for(let id of [...this.world.ids()]) if(!this.world.has(id, 'Player')) this.world.destroy(id);
    this.terrain.clear();
    this.terrain.world = world;
    if(world === DEFAULT_WORLD) await this.room.storage.delete('world'); else await this.room.storage.put('world', world);
    let keys = [...(await this.room.storage.list({ prefix: 'chunk:' })).keys(), ...(await this.room.storage.list({ prefix: 'chunkpart:' })).keys(), ...(await this.room.storage.list({ prefix: 'ent:' })).keys()];
    this.chunkParts = new Map();
    for(let i = 0; i < keys.length; i += STORAGE_BATCH) await this.room.storage.delete(keys.slice(i, i + STORAGE_BATCH));
    this.persistQueue.clear(); this.persistRemoved.clear(); this.persistChunks = new Set(); this.persistChunkDeletes = new Set();
    this.sentStates = new Map();
    this.connectivity.clear();
  }

  async reset() {
    await this.clearWorld();
    this.connectivity.solve();
    this.refreshActivity(true);
    this.chunkDelta = null;
    this.room.broadcast(JSON.stringify(this.fullUpdate()));
    this.world.takeDirty();
  }

  // ---- world import (manifest from tools/import-world.mjs, uploaded by a client in batches) ----

  async importBegin(data) {
    let world = sanitizeWorld(data.world);
    if(!world) return;
    await this.clearWorld(world);
    this.connectivity.solve();
    this.importing = true;
    this.room.broadcast(JSON.stringify({ type: "chat", sender: "server", message: `Importing world${data.name ? ' ' + String(data.name).slice(0, 40) : ''}...` }));
  }

  importChunks(data) {
    if(!this.importing || !data.chunks || typeof data.chunks !== 'object') return;
    let n = 0;
    this.importPartial ||= new Map(); // key -> base64 pieces of a chunk too large for one message
    for(let key in data.chunks) {
      let c = data.chunks[key];
      if(!isValidKey(key) || !c || typeof c.bytes !== 'string') continue;
      let b64 = c.bytes;
      if(c.parts > 1) {
        let acc = this.importPartial.get(key) || [];
        acc[c.part | 0] = b64;
        this.importPartial.set(key, acc);
        if(acc.filter(Boolean).length < c.parts) continue;
        b64 = acc.join('');
        this.importPartial.delete(key);
      }
      try {
        let bytes = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
        this.terrain.loadChunk(key, bytes);
        this.markChunkPersist(key);
        n++;
      } catch(e) { console.warn(`import: bad chunk ${key}: ${e.message}`); }
    }
    return n;
  }

  async importEnd() {
    if(!this.importing) return;
    this.importing = false;
    let shed = this.settleTerrain();
    for(let k in this.terrain.takeDirty()) this.markChunkPersist(k);
    this.refreshActivity(true);
    this.chunkDelta = null;
    this.room.broadcast(JSON.stringify(this.fullUpdate()));
    this.world.takeDirty();
    await this.persist();
    console.log(`import: ${Object.keys(this.terrain.chunks).length} chunks, ${shed} fragment(s) shed, ${Object.keys(this.physics.chunkActors).length} chunk colliders`);
  }

  // ---- messages -----------------------------------------------------------

  /** @param {string} message @param {Connection} sender */
  async onMessage(message, sender) {
    if(!this.ready || !message.startsWith("{")) return;
    let data; try { data = JSON.parse(message); } catch { return; }
    let w = this.world;
    let me = sender.id;

    switch(data.type) {
      case "player": {
        let tf = w.get(me, 'Transform'); if(!tf) break;
        let p = vec3(data.position, tf.position);
        tf.position.x = p.x; tf.position.y = p.y; tf.position.z = p.z;
        w.touch(me, 'Transform');
        break;
      }
      case "name":
        if(w.has(me, 'Player')) w.set(me, 'Player', { name: String(data.name || 'Player').slice(0, 32) });
        break;

      case "csg":
        this.applyCsg(data);
        break;

      case "spawnphyscube":
        this.spawnProp('cube', vec3(data.position, { x: 0, y: 5, z: 0 }), quat(null));
        break;
      case "spawnprop":
        this.spawnProp(String(data.propId || 'crate'), vec3(data.position, { x: 0, y: 5, z: 0 }), quat(data.quaternion));
        break;

      case "physgun_grab":
        if(w.has(data.bodyId, 'RigidBody') && !w.has(data.bodyId, 'Grabbed')) w.add(data.bodyId, 'Grabbed', Grabbed({ by: me }));
        break;
      case "physgun_move": {
        let g = w.get(data.bodyId, 'Grabbed');
        if(g && g.by === me) w.add(data.bodyId, '$GrabTarget', { pos: vec3(data.targetPos), quat: quat(data.targetQuat) });
        break;
      }
      case "physgun_release":
        this.releaseHold(me, data.bodyId);
        break;
      case "physgun_freeze": {
        let rb = w.get(data.bodyId, 'RigidBody'); if(!rb) break;
        if(w.has(data.bodyId, 'Grabbed')) w.remove(data.bodyId, 'Grabbed');
        this.physics.setFrozen(w, data.bodyId, !rb.frozen);
        break;
      }

      case "createjoint":
        this.createJoint(data);
        break;
      case "removejoint":
        if(w.has(data.jointId, 'Joint')) w.destroy(data.jointId);
        break;
      case "deletebody":
        if(w.has(data.bodyId, 'RigidBody')) w.destroy(data.bodyId);
        break;

      // Legacy static models placed by URL
      case "model": {
        let id = String(data.id);
        let tf = { position: vec3(data.position), quaternion: quat(data.quaternion), scale: vec3(data.scale, { x: 1, y: 1, z: 1 }) };
        if(!w.has(id)) w.create(id, { Model: Model({ url: String(data.url || ''), selectedBy: data.selectedBy || "" }), Transform: Transform(tf) });
        else { w.set(id, 'Transform', tf); if(data.url) w.set(id, 'Model', { url: String(data.url) }); }
        break;
      }
      case "select":   if(w.has(data.id, 'Model')) w.set(String(data.id), 'Model', { selectedBy: me }); break;
      case "deselect": if(w.has(data.id, 'Model')) w.set(String(data.id), 'Model', { selectedBy: "" }); break;
      case "deletemodel": if(w.has(data.id, 'Model')) w.destroy(String(data.id)); break;

      case "chat":
        this.room.broadcast(JSON.stringify({ type: "chat", sender: me, message: String(data.message || '').slice(0, 500) }));
        break;
      case "reset":
        await this.reset();
        break;
      case "import_begin": await this.importBegin(data); break;
      case "import_chunks": this.importChunks(data); break;
      case "import_end": await this.importEnd(); break;
      default:
        console.error("Unknown message type: " + data.type);
    }
  }
}

export default PartyServer;
