/* eslint-env browser */
// @ts-check
/** @typedef {import("partyserver").Connection} Connection */
/** @typedef {import("partyserver").ConnectionContext} ConnectionContext */

import { Server, routePartykitRequest } from 'partyserver';
import * as THREE from 'three';
import { ADDITION, SUBTRACTION } from 'three-bvh-csg';
import { World } from './ecs/World.js';
import { Game } from './server/Game.js';
import { Transform, RigidBody, Prop, Joint, Grabbed, Player, Model, PERSISTED } from './ecs/components.js';
import { Physics } from './server/Physics.js';
import { Terrain, chunkCenter } from './server/Terrain.js';
import { Connectivity, DUST_VOLUME, MAX_FRAGMENT_VOLUME, decomposeParts } from './server/Connectivity.js';
import { chunkAt, chunksInBox, key as chunkKey, isValidKey, sanitizeWorld, DEFAULT_WORLD } from './terrain/grid.js';
import { DEFAULT_BODY_GRAVITY, clampGravity } from './gravity.js';
import { getPropDef } from './props/PropRegistry.js';
import { packChunkFrame, packChunkDeltaFrame, encodeChunkDelta, decodeSoup, encodeSoup, encodeHulls } from './net/codec.js';

const TICK_MS = 1000 / 30;
const FULL_UPDATE_EVERY = 300;      // ticks (10s)
const PERSIST_INTERVAL_MS = 5000;
const STORAGE_BATCH = 128;          // Durable Object storage batch limit
const STORAGE_PART = 100 * 1024;    // chunk bytes above this are split across chunkpart:<key>:<i> values (128 KiB value limit)
const COOKS_NOW = 3;                // mesh colliders cooked immediately when activity changes (nearest first) ...
const COOKS_PER_TICK = 2;           // ... and per tick for the rest

// Brushes the server carves with itself (explosions, the drill, the mason): unit shapes, scaled per use
const SPHERE_SOUP = encodeSoup(new THREE.IcosahedronGeometry(1, 2).attributes.position.array); // 320 faces: craters read as round
const CUBE_SOUP = encodeSoup(new THREE.BoxGeometry(1, 1, 1).toNonIndexed().attributes.position.array);

const PLAYER_COLORS = ["#FF0000", "#0000FF", "#FFFF00", "#FF00FF", "#00FFFF", "#FF8000", "#FF0080", "#8000FF", "#0080FF", "#80FF00", "#00FF80", "#FF8080", "#8080FF", "#FF80FF", "#80FFFF", "#FFFF80"];

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v)) ? v : d;
const vec3 = (v, d = { x: 0, y: 0, z: 0 }) => v ? { x: num(v.x, d.x), y: num(v.y, d.y), z: num(v.z, d.z) } : { ...d };
const quat = (q) => q ? { x: num(q.x), y: num(q.y), z: num(q.z), w: num(q.w, 1) } : { x: 0, y: 0, z: 0, w: 1 };

/** One room: a Durable Object bound as `Main`, so clients reach it at /parties/main/<room>. The simulation
 *  lives in memory and ticks on a timer, so the object must not hibernate. */
export class WorldParty extends Server {
  static options = { hibernate: false };

  constructor(ctx, env) {
    super(ctx, env);
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
    this.pushed = new Map();        // key -> version last broadcast as a chunk frame
    this.cookQueue = new Map();     // key -> version of mesh colliders still to cook (nearest to activity first)
    this.persistSummaries = new Set(); // chunk keys whose connectivity summary should be written
    this.connectivity.onSummary = key => this.persistSummaries.add(key);
    this.settleTimer = null;        // pending settleNow() after carves
    this.carveBoxes = [];           // bounds of the brushes run since the last settleNow (the glow rocks they can uncover)
    this.csgStats = { ops: 0, booleanMs: 0, deltaBytes: 0, fullBytes: 0 };
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
    this.conns = new Map();         // connection id -> Connection (for messages to one player)
    this.game = new Game(this);     // Fort War rules; active when the world config carries `game`
    this.interval = setInterval(() => this.tick(), TICK_MS);
  }

  // ---- lifecycle ----------------------------------------------------------

  async onStart() {
    let [storedChunks, storedEntities, storedWorld] = await Promise.all([this.loadPrefixed('chunk:'), this.loadPrefixed('ent:'), this.ctx.storage.get('world')]);
    await this.joinChunkParts(storedChunks);

    // Legacy single-blob layout
    let legacyChunks = await this.ctx.storage.get("chunks");
    if(legacyChunks) { Object.assign(storedChunks, legacyChunks); await this.ctx.storage.delete("chunks"); }
    // Legacy numeric chunk indices (x*100+y*10+z over a 10^3 grid centred on the origin) -> "x,y,z" keys
    for(let k of Object.keys(storedChunks)) {
      if(!/^\d+$/.test(k)) continue;
      let i = parseInt(k), nk = chunkKey(Math.floor(i / 100) - 5, Math.floor(i / 10) % 10 - 5, i % 10 - 5);
      storedChunks[nk] = { ...storedChunks[k], key: nk };
      delete storedChunks[k];
      this.persistChunkDeletes.add('chunk:' + k);
      this.markChunkPersist(nk);
    }

    await this.terrain.init(storedChunks, storedWorld);
    await this.physics.init();
    this.applyGravity();
    // Stored connectivity summaries spare us rebuilding every chunk's manifold just to start
    let storedSummaries = await this.loadPrefixed('summary:');
    let adopted = 0;
    for(let k in storedSummaries) if(this.connectivity.importSummary(k, storedSummaries[k])) adopted++; else this.persistChunkDeletes.add('summary:' + k);

    let maxId = 0;
    for(let id in storedEntities) {
      this.world.create(id, storedEntities[id]);
      let m = /^e(\d+)$/.exec(id); if(m) maxId = Math.max(maxId, parseInt(m[1]));
    }
    this.world.nextId = maxId + 1;
    let upgraded = this.upgradeFragments();
    this.world.takeDirty(); // loaded state is not "changed"
    this.persistQueue.clear(); this.persistRemoved.clear();
    for(let id of upgraded) this.persistQueue.add(id);
    // Chunks loaded from the legacy soup format are re-encoded and flagged for re-persist
    for(let k in this.terrain.takeDirty()) this.markChunkPersist(k);
    // Ground check with the current algorithm: anything unsupported falls now
    let shed = this.terrain.cold(() => this.settleTerrain());
    for(let k in this.terrain.takeDirty()) this.markChunkPersist(k);
    this.refreshActivity(true);
    this.terrain.dropPrev(Object.keys(this.terrain.chunks));
    this.game.onWorldChanged();
    this.game.onImported(); // a new level means a fresh match: treasure laid out again, clock and scores reset
    this.world.takeDirty();
    this.ready = true;
    this.resolveReady();
    // A Fort War room imported before pristine copies existed gets one now (rounds restore the terrain from it)
    if(this.game.active && (await this.ctx.storage.list({ prefix: 'pristine:', limit: 1 })).size === 0) await this.savePristine();
    console.log(`World ready: ${Object.keys(storedChunks).length} chunks (${adopted} summaries stored), ${Object.keys(storedEntities).length} entities, ${shed} fragment(s) shed, ${Object.keys(this.physics.chunkActors).length} chunk colliders (${this.cookQueue.size} queued); wasm heaps: manifold ${this.terrain.heapMB().toFixed(0)} MB, physx ${this.physics.heapMB().toFixed(0)} MB`);
  }

  async loadPrefixed(prefix) {
    let out = {};
    let map = await this.ctx.storage.list({ prefix });
    for(let [key, value] of map) out[key.slice(prefix.length)] = value;
    return out;
  }

  /** Chunk records whose bytes were split into parts get them joined back. */
  async joinChunkParts(storedChunks) {
    let parts = await this.ctx.storage.list({ prefix: 'chunkpart:' });
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

  /** Fragments stored before hull colliders existed get hulls now (else they would simulate as SDF meshes, which
   *  is what made ticks crawl whenever a pile woke up). Returns the ids changed, so they can be re-persisted. */
  upgradeFragments() {
    let ids = [];
    for(let [id, f] of this.world.each('FragmentMesh')) {
      if(f.hulls !== null && f.hulls !== undefined) continue;
      let hulls = null;
      try { hulls = this.terrain.hullsFromSoup(f.data); } catch(e) { console.warn(`fragment ${id}: hulls failed: ${e.message}`); }
      if(!hulls || !hulls.length) hulls = [decodeSoup(f.data)]; // not manifold: one hull of every vertex
      this.world.set(id, 'FragmentMesh', { hulls: encodeHulls(hulls) });
      ids.push(id);
    }
    if(ids.length) console.log(`upgraded ${ids.length} fragment(s) to hull colliders`);
    return ids;
  }

  /** Solve connectivity and turn every unsupported solid into fragment entities. Returns the number made. */
  settleTerrain() {
    let made = 0;
    let M = this.terrain.manifold.Manifold;
    for(let pass = 0; pass < 4; pass++) {
      this.connectivity.solve();
      let floating = this.connectivity.floatingComponents();
      if(!floating.length) break;
      floating = floating.filter(comp => {
        if(comp.volume <= MAX_FRAGMENT_VOLUME) return true;
        console.log(`Keeping unsupported terrain of volume ${comp.volume.toFixed(0)} (too large to drop)`);
        return false;
      });
      // Which islands leave each chunk, and how many components still need the chunk's islands. The
      // summaries keep only footprints, so a chunk is decomposed again (same order: decompose is
      // deterministic for a mesh) when first needed, and rebuilt and freed as soon as its last component
      // is done, so memory holds a component's chunks at a time rather than every touched chunk.
      let removed = new Map(), usesLeft = new Map(); // key -> Set of island k; key -> count
      for(let comp of floating) {
        for(let { key, k } of comp.islands) { if(!removed.has(key)) removed.set(key, new Set()); removed.get(key).add(k); }
        for(let key of new Set(comp.islands.map(i => i.key))) usesLeft.set(key, (usesLeft.get(key) || 0) + 1);
      }
      let parts = new Map(); // key -> Manifold[] | null (rock chunks have no record; their one island is the cube)
      let partsOf = key => {
        if(!parts.has(key)) {
          let m = this.terrain.chunks[key] ? this.terrain.manifoldOf(key) : null;
          let p = m ? decomposeParts(m, M) : null;
          let S = this.connectivity.summary(key);
          if(p && p.length !== S.solid.length) console.warn(`chunk ${key}: ${p.length} islands now, ${S.solid.length} in its summary`);
          parts.set(key, p);
        }
        return parts.get(key);
      };
      let release = key => { // rebuild the chunk from the islands that stay, free the rest
        let p = partsOf(key), keep = (p || []).filter((_, k) => !removed.get(key).has(k));
        this.terrain.setManifold(key, keep.length ? M.compose(keep) : null);
        if(p) for(let m of p) m.delete();
        parts.delete(key);
      };
      for(let comp of floating) {
        let keys = new Set(comp.islands.map(i => i.key));
        if(comp.volume >= DUST_VOLUME) {
          let temps = [];
          let pieces = comp.islands.map(({ key, k }) => {
            let p = partsOf(key);
            if(p && p[k]) return p[k];
            let rock = this.terrain.rockManifold(key); temps.push(rock); return rock;
          });
          let merged = pieces.length === 1 ? M.compose([pieces[0]]) : M.union(pieces);
          for(let t of temps) t.delete();
          let comps = this.terrain.fragmentComponents(merged);
          merged.delete();
          if(comps) { this.world.create(comps); made++; }
        }
        for(let key of keys) { let n = usesLeft.get(key) - 1; usesLeft.set(key, n); if(n === 0) release(key); }
      }
      // Removing solid can merge hollows, so solve again; normally nothing is left floating.
    }
    return made;
  }

  /** Chunks containing a player or an awake body. Sleeping bodies do not keep terrain loaded or collided:
   *  nothing can reach them except through an active region, and their chunks' colliders come back
   *  (waking them) as soon as something does. */
  occupiedChunks() {
    let set = new Set();
    for(let [id, tf] of this.world.each('Transform')) {
      let rb = this.world.get(id, 'RigidBody');
      if(this.world.has(id, 'Player') || this.world.has(id, 'Projectile') || (rb && !rb.sleeping)) set.add(chunkAt(this.terrain.world, tf.position));
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

  /** Bring colliders in line with chunk states. Removals and box colliders are immediate; mesh colliders
   *  are cooked nearest-to-activity first, a few now and the rest over the following ticks, so a region
   *  becoming active (or a room starting) does not stall on cooking every dense chunk at once. */
  syncColliders() {
    for(let key of new Set([...this.chunkStates.keys(), ...this.colliderState.keys()])) {
      let st = this.chunkStates.get(key);
      let want = !st ? undefined : st.mask !== undefined ? 'box' : 'mesh:' + this.terrain.chunks[key].version;
      if(want === this.colliderState.get(key)) continue;
      if(want) this.colliderState.set(key, want); else this.colliderState.delete(key);
      this.cookQueue.delete(key);
      if(!want) this.physics._removeChunkActor(key);
      else if(want === 'box') { let c = chunkCenter(key); this.physics.setDefaultChunkCollider(key, c.x, c.y, c.z); }
      else this.cookQueue.set(key, this.terrain.chunks[key].version);
    }
    this.pumpCooks(COOKS_NOW);
  }

  /** Colliders for the chunks around `positions` right now (bodies are about to be created there). */
  cookAround(positions) {
    if(!positions.length) return;
    this.refreshActivity(true);
    for(let p of positions) for(let dy of [0, -1]) {
      let key = chunkAt(this.terrain.world, { x: p.x, y: p.y + dy * 2, z: p.z });
      if(key && this.cookQueue.has(key)) { let v = this.cookQueue.get(key); this.cookQueue.delete(key); this.physics.setChunkCollider(key, this.terrain.chunkMesh(key)); if(this.colliderState.get(key) !== 'mesh:' + v) this.colliderState.set(key, 'mesh:' + v); }
    }
  }

  /** Cook up to n queued mesh colliders, nearest to a player or awake body first. */
  pumpCooks(n) {
    if(!this.cookQueue.size) return;
    let anchors = [];
    for(let [id, tf] of this.world.each('Transform')) {
      let rb = this.world.get(id, 'RigidBody');
      if(this.world.has(id, 'Player') || (rb && !rb.sleeping)) anchors.push(tf.position);
    }
    let dist = key => { let c = chunkCenter(key), d = Infinity; for(let p of anchors) d = Math.min(d, (p.x - c.x) ** 2 + (p.y - c.y) ** 2 + (p.z - c.z) ** 2); return d; };
    let order = [...this.cookQueue.keys()].sort((a, b) => dist(a) - dist(b));
    for(let key of order.slice(0, n)) {
      let version = this.cookQueue.get(key);
      this.cookQueue.delete(key);
      if(this.colliderState.get(key) !== 'mesh:' + version) continue; // superseded meanwhile
      this.physics.setChunkCollider(key, this.terrain.chunkMesh(key));
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
    // A client reconnecting with the same id before its old socket closed must not fail with "entity exists"
    if(this.world.has(conn.id)) this.onDisconnect(conn);
    this.conns.set(conn.id, conn);
    this.world.create(conn.id, {
      Player: Player({ name: "Player " + this.globalPlayerCount, color: PLAYER_COLORS[this.globalPlayerCount % PLAYER_COLORS.length] }),
      Transform: Transform(),
    });
    conn.send(JSON.stringify(this.fullUpdate()));
    this.game.onConnect(conn.id); // team and spawn point follow in the next partial update
    console.log(`Connected: ${conn.id} room: ${this.name} url: ${new URL(ctx.request.url).pathname}`);
  }

  /** @param {Connection} conn */
  onDisconnect(conn) {
    this.conns.delete(conn.id);
    if(!this.world.has(conn.id)) return;
    // Drop anything this player was holding, then the player itself
    this.game.onDisconnect(conn.id);
    for(let [id, g] of this.world.each('Grabbed')) if(g.by === conn.id) this.world.remove(id, 'Grabbed');
    this.world.destroy(conn.id);
    this.persist().catch(e => console.error('persist failed: ' + e.message));
  }
  onClose(conn) { this.onDisconnect(conn); }
  onError(conn, error) { console.error(error); this.onDisconnect(conn); }

  // ---- tick ---------------------------------------------------------------

  tick() {
    if(!this.ready) return;
    let start = Date.now();
    let players = this.world.query('Player').size;

    // Nothing to simulate: no players and everything asleep
    if(players === 0 && !this.anyAwake && !this.world.hasDirty() && !this.chunkDelta && !this.cookQueue.size) {
      this.physics.lastTime = start;
      return;
    }

    this.pumpCooks(COOKS_PER_TICK);
    this.anyAwake = this.physics.update(this.world, TICK_MS / 1000);
    this.game.update(TICK_MS / 1000, start);
    this.tickCount++;
    this.refreshActivity();

    if(players > 0) {
      if(this.tickCount % FULL_UPDATE_EVERY === 0) {
        this.broadcast(JSON.stringify(this.fullUpdate(false)));
        this.world.takeDirty(); this.chunkDelta = null;
      } else if(this.world.hasDirty() || this.chunkDelta) {
        let { entities, removed } = this.world.takeDirty();
        let d = this.chunkDelta || {};
        this.chunkDelta = null;
        this.broadcast(JSON.stringify({ type: "partialupdate", entities, removed, chunks: d.chunks, rock: d.rock, cull: d.cull, serverTickMs: this.serverTickMs }));
      }
    }

    if(start - this.lastPersist > PERSIST_INTERVAL_MS) this.persist();
    this.serverTickMs = Date.now() - start;
  }

  /** Every entity and chunk state. The periodic resync (`withMeshes` false) leaves out FragmentMesh: it never changes
   *  after creation and clients got it then, and a room with rubble lying around would otherwise ship a megabyte of
   *  geometry to every client every ten seconds (and carve frames behind it would wait on the wire). The Transforms of
   *  embedded glow rocks stay out for the same reason: hundreds of them, none moving. */
  fullUpdate(withMeshes = true) {
    let entities = withMeshes ? this.world.serialize()
      : this.world.serialize((id, name) => name !== 'FragmentMesh' && !(name === 'Transform' && this.world.has(id, 'GlowRock') && !this.world.has(id, 'RigidBody'))); // nor where an embedded glow rock lies: it does not move
    return { type: "fullupdate", entities, removed: [], world: this.terrain.world, ...this.chunkMaps(), serverTickMs: this.serverTickMs };
  }

  // ---- persistence (per-entity / per-chunk keys) --------------------------

  async persist() {
    this.lastPersist = Date.now();
    await this.terrain.compress(this.persistChunks || []); // normally done already; never gzip synchronously here
    let puts = {};
    for(let id of this.persistQueue) {
      if(!this.world.has(id) || this.world.has(id, 'Player') || this.world.has(id, 'Projectile')) continue;
      let s = this.world.serializeEntity(id, (_, name) => PERSISTED.has(name));
      if(s && Object.keys(s).length > 0) puts['ent:' + id] = s;
    }
    let deletes = [...this.persistRemoved].map(id => 'ent:' + id);
    for(let key of this.persistChunks || []) {
      let c = this.terrain.serializeChunk(key);
      let oldParts = this.chunkParts.get(key) || 0;
      if(!c) { deletes.push('chunk:' + key, 'summary:' + key); for(let i = 0; i < oldParts; i++) deletes.push(`chunkpart:${key}:${i}`); this.chunkParts.delete(key); continue; }
      let n = c.bytes && c.bytes.length > STORAGE_PART ? Math.ceil(c.bytes.length / STORAGE_PART) : 0;
      if(n) {
        puts['chunk:' + key] = { key, version: c.version, parts: n };
        for(let i = 0; i < n; i++) puts[`chunkpart:${key}:${i}`] = c.bytes.slice(i * STORAGE_PART, (i + 1) * STORAGE_PART);
      } else puts['chunk:' + key] = c;
      for(let i = n; i < oldParts; i++) deletes.push(`chunkpart:${key}:${i}`);
      this.chunkParts.set(key, n);
    }
    for(let key of this.persistSummaries) {
      let sum = this.connectivity.exportSummary(key);
      if(sum) puts['summary:' + key] = sum; else deletes.push('summary:' + key);
    }
    for(let key of this.persistChunkDeletes) deletes.push(key);
    this.persistQueue.clear(); this.persistRemoved.clear(); this.persistChunks = new Set(); this.persistChunkDeletes = new Set(); this.persistSummaries = new Set();

    let keys = Object.keys(puts);
    for(let i = 0; i < keys.length; i += STORAGE_BATCH) {
      let batch = {};
      for(let k of keys.slice(i, i + STORAGE_BATCH)) batch[k] = puts[k];
      await this.ctx.storage.put(batch);
    }
    for(let i = 0; i < deletes.length; i += STORAGE_BATCH) await this.ctx.storage.delete(deletes.slice(i, i + STORAGE_BATCH));
  }

  markChunkPersist(key) { (this.persistChunks ||= new Set()).add(key); }

  // ---- gameplay helpers ---------------------------------------------------

  /** Send a JSON message to one connection. */
  send(id, msg) { let c = this.conns.get(id); if(c) try { c.send(JSON.stringify(msg)); } catch(e) { console.warn(`send to ${id} failed: ${e.message}`); } }

  /** Server-side carves and additions reuse the client's csg path with the server's own unit brushes. */
  carveSphere(center, radius, material = 1) {
    let min = { x: center.x - radius, y: center.y - radius, z: center.z - radius }, max = { x: center.x + radius, y: center.y + radius, z: center.z + radius };
    return this.applyCsg({ keys: chunksInBox(this.terrain.world, min, max), brush: SPHERE_SOUP, operation: SUBTRACTION, material, position: center, quaternion: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: radius, y: radius, z: radius }, tolerance: 0.02 });
  }
  carveBox(center, quaternion, size, material = 1) { return this.boxCsg(center, quaternion, size, material, SUBTRACTION); }
  addBox(center, quaternion, size, material = 0) { return this.boxCsg(center, quaternion, size, material, ADDITION); }
  boxCsg(center, quaternion, size, material, operation) {
    let r = Math.hypot(size.x, size.y, size.z) / 2; // a sphere around the rotated box bounds the chunks it can touch
    let min = { x: center.x - r, y: center.y - r, z: center.z - r }, max = { x: center.x + r, y: center.y + r, z: center.z + r };
    return this.applyCsg({ keys: chunksInBox(this.terrain.world, min, max), brush: CUBE_SOUP, operation, material, position: center, quaternion, scale: size });
  }

  /** Fort War keeps the imported terrain so every round can start from it. */
  async savePristine() {
    let keys = [...(await this.ctx.storage.list({ prefix: 'pristine:' })).keys()];
    for(let i = 0; i < keys.length; i += STORAGE_BATCH) await this.ctx.storage.delete(keys.slice(i, i + STORAGE_BATCH));
    await this.terrain.compress(Object.keys(this.terrain.chunks));
    let puts = {};
    for(let key in this.terrain.chunks) { let c = this.terrain.serializeChunk(key); if(c && c.bytes) puts['pristine:' + key] = c; }
    let names = Object.keys(puts);
    for(let i = 0; i < names.length; i += STORAGE_BATCH) { let batch = {}; for(let k of names.slice(i, i + STORAGE_BATCH)) batch[k] = puts[k]; await this.ctx.storage.put(batch); }
    console.log(`pristine terrain saved: ${names.length} chunks`);
  }

  /** Put the terrain back as it was imported (new round); entities other than players and the match go away. */
  async restorePristine() {
    let stored = await this.loadPrefixed('pristine:');
    if(!Object.keys(stored).length) return false;
    for(let id of [...this.world.ids()]) if(!this.world.has(id, 'Player') && id !== 'match') this.world.destroy(id);
    for(let key of Object.keys(this.terrain.chunks)) this.markChunkPersist(key); // stale ones get deleted, kept ones rewritten
    this.terrain.clear();
    this.connectivity.clear();
    for(let key of Object.keys(this.physics.chunkActors)) this.physics._removeChunkActor(key);
    this.colliderState = new Map(); this.cookQueue = new Map(); this.sentStates = new Map(); this.pushed = new Map();
    for(let k in stored) { let c = stored[k]; if(!isValidKey(k) || !c.bytes) continue; this.terrain.loadChunk(k, c.bytes, c.version); this.markChunkPersist(k); }
    let shed = this.terrain.cold(() => this.settleTerrain());
    for(let k in this.terrain.takeDirty()) this.markChunkPersist(k);
    this.refreshActivity(true);
    this.terrain.dropPrev(Object.keys(this.terrain.chunks));
    this.chunkDelta = null;
    this.broadcast(JSON.stringify(this.fullUpdate()));
    this.world.takeDirty();
    await this.persist();
    console.log(`terrain restored: ${Object.keys(this.terrain.chunks).length} chunks, ${shed} fragment(s) shed`);
    return true;
  }

  spawnProp(propId, position, quaternion) {
    let def = getPropDef(propId);
    return this.world.create({
      Transform: Transform({ position, quaternion }),
      RigidBody: RigidBody({ shape: def.shape, halfExtent: def.halfExtent, propId: def.id }),
      Prop: Prop({ propId: def.id, url: def.url }),
    });
  }

  /** Run the boolean and push the new bytes right away; grounding, colliders and activity follow once the
   *  frames are on the wire (a timer callback), so the cut is visible as early as the boolean allows. */
  async applyCsg(data) {
    // Chunks not resident are decoded with the native gunzip first; the boolean itself is synchronous.
    await this.terrain.prepare((data.keys || []).filter(k => typeof k === 'string'));
    let t0 = Date.now();
    this.terrain.applyCsg(data);
    this.csgStats.booleanMs += Date.now() - t0;
    if(this.terrain.dirty.size === 0) return;
    if(data.position && data.scale) { // the brush's bounds, generously: the unit brushes fit a unit sphere or cube
      let p = vec3(data.position), s = vec3(data.scale, { x: 1, y: 1, z: 1 }), R = Math.hypot(s.x, s.y, s.z);
      this.carveBoxes.push({ min: { x: p.x - R, y: p.y - R, z: p.z - R }, max: { x: p.x + R, y: p.y + R, z: p.z + R } });
    }
    this.csgStats.ops++;
    for(let key of this.terrain.dirty) this.pushChunk(key);
    if(!this.settleTimer) this.settleTimer = setTimeout(() => { this.settleTimer = null; this.settleNow(); }, 0);
  }

  /** Broadcast a chunk's new content to everyone who holds it, unless they already got this version: as
   *  a delta from the version they hold when the chunk only changed a little (the usual carve), else in
   *  full. Clients that hold something else learn the version from the next update and fetch over HTTP. */
  pushChunk(key) {
    let st = this.sentStates.get(key), c = this.terrain.chunks[key];
    if(!st || st.version === undefined || !c || !this.terrain.hasSolid(key) || this.pushed.get(key) === c.version) return;
    let base = this.pushed.get(key) ?? st.version;
    let frame = null;
    if(c.prev && c.prev.version === base) {
      let delta = encodeChunkDelta(this.terrain.prevMesh(key), this.terrain.currentMesh(key));
      // Worth it unless it is about as big as the full gzip would be (chunk layouts gzip to ~60%)
      let fullEstimate = c.bytes ? c.bytes.length : c.raw.length * 0.6;
      if(delta.length < fullEstimate * 0.75) frame = packChunkDeltaFrame(key, c.version, base, delta);
      this.csgStats.deltaBytes += frame ? delta.length : 0;
    }
    if(!frame) { let bytes = this.terrain.bytesOf(key); this.csgStats.fullBytes += bytes.length; frame = packChunkFrame(key, c.version, bytes); }
    this.pushed.set(key, c.version);
    this.broadcast(frame);
  }

  /** Grounding, colliders and activity for every chunk carved since the last time. */
  settleNow() {
    if(this.importing || this.terrain.dirty.size === 0) return;
    let carved = new Set(this.terrain.dirty);
    let t0 = Date.now();
    let fragments = this.settleTerrain();
    let settleMs = Date.now() - t0;
    t0 = Date.now();
    this.refreshActivity(true);
    let activityMs = Date.now() - t0; // includes PhysX cooking of changed chunk colliders
    let changed = this.terrain.takeDirty();
    for(let key in changed) { this.markChunkPersist(key); this.pushChunk(key); this.physics.wakeNear(key); } // settle may have changed some again
    let boxes = this.carveBoxes; this.carveBoxes = [];
    let rocks = this.game.onTerrainChanged(boxes, carved, Object.keys(changed)); // before dropPrev: it compares against the replaced content
    this.terrain.dropPrev(Object.keys(changed));
    this.terrain.compress(Object.keys(changed)).catch(e => console.error('compress failed: ' + e.message)); // native gzip, after the frames are out
    let st = this.csgStats; this.csgStats = { ops: 0, booleanMs: 0, deltaBytes: 0, fullBytes: 0 };
    console.log(`csg: ${st.ops} op(s), ${Object.keys(changed).length} chunk(s) changed, ${fragments} fragment(s), ${Object.keys(this.physics.chunkActors).length} chunk colliders; pushed ${(st.deltaBytes / 1024).toFixed(0)} KB as deltas + ${(st.fullBytes / 1024).toFixed(0)} KB full; boolean+encode ${st.booleanMs}ms, settle ${settleMs}ms, colliders+activity ${activityMs}ms${rocks ? `; glow rocks: ${rocks.made} new, ${rocks.freed} freed, ${rocks.updated} updated (${rocks.measured} measured, ${rocks.rays} rays, ${rocks.bvhBuilds} BVHs) ${rocks.ms}ms` : ''}`);
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
    if(!this.terrain.hasSolid(key)) return new Response(null, { status: 204, headers });
    await this.terrain.compress([key]);
    let bytes = this.terrain.bytesOf(key);
    if(!bytes || this.terrain.chunks[key].version !== c.version) return new Response("Changed", { status: 409 });
    headers["Content-Type"] = "application/octet-stream";
    return new Response(bytes, { status: 200, headers });
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

  /** Body gravity follows the world config (`?gravity=` on the client sets it; an import replaces it). */
  applyGravity() { this.physics.setGravity(this.world, this.terrain.world.gravity ?? DEFAULT_BODY_GRAVITY); }

  async setGravity(g) {
    g = clampGravity(g);
    if(g === null || g === (this.terrain.world.gravity ?? DEFAULT_BODY_GRAVITY)) return;
    let world = { ...this.terrain.world };
    if(g === DEFAULT_BODY_GRAVITY) delete world.gravity; else world.gravity = g;
    this.terrain.world = world;
    this.applyGravity();
    await this.ctx.storage.put('world', world);
    this.broadcast(JSON.stringify({ type: "chat", sender: "server", message: `Gravity is now ${g.toFixed(2)} m/s² (${(g / 9.81).toFixed(2)} g)` }));
    this.broadcast(JSON.stringify(this.fullUpdate(false)));
    this.world.takeDirty(); this.chunkDelta = null;
  }

  /** Wipe terrain, entities and their storage; the world config becomes `world` (default: the sandbox). */
  async clearWorld(world = DEFAULT_WORLD) {
    for(let id of [...this.world.ids()]) if(!this.world.has(id, 'Player')) this.world.destroy(id);
    this.terrain.clear();
    this.terrain.world = world;
    this.applyGravity();
    if(world === DEFAULT_WORLD) await this.ctx.storage.delete('world'); else await this.ctx.storage.put('world', world);
    let keys = [];
    for(let prefix of ['chunk:', 'chunkpart:', 'summary:', 'ent:', 'pristine:']) keys.push(...(await this.ctx.storage.list({ prefix })).keys());
    this.chunkParts = new Map();
    for(let i = 0; i < keys.length; i += STORAGE_BATCH) await this.ctx.storage.delete(keys.slice(i, i + STORAGE_BATCH));
    this.persistQueue.clear(); this.persistRemoved.clear(); this.persistChunks = new Set(); this.persistChunkDeletes = new Set(); this.persistSummaries = new Set();
    this.sentStates = new Map();
    this.pushed = new Map();
    this.cookQueue = new Map();
    this.connectivity.clear();
  }

  async reset() {
    await this.clearWorld();
    this.connectivity.solve();
    this.refreshActivity(true);
    this.game.onWorldChanged();
    this.chunkDelta = null;
    this.broadcast(JSON.stringify(this.fullUpdate()));
    this.world.takeDirty();
  }

  // ---- world import (manifest from tools/import-world.mjs, uploaded by a client in batches) ----

  async importBegin(data) {
    let world = sanitizeWorld(data.world);
    if(!world) return;
    await this.clearWorld(world);
    this.connectivity.solve();
    this.importing = true;
    this.broadcast(JSON.stringify({ type: "chat", sender: "server", message: `Importing world${data.name ? ' ' + String(data.name).slice(0, 40) : ''}...` }));
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
        this.terrain.loadChunk(key, bytes, typeof c.version === 'string' && /^[0-9a-f]{8}$/.test(c.version) ? c.version : null);
        this.markChunkPersist(key);
        n++;
      } catch(e) { console.warn(`import: bad chunk ${key}: ${e.message}`); }
    }
    return n;
  }

  async importEnd() {
    if(!this.importing) return;
    this.importing = false;
    let shed = this.terrain.cold(() => this.settleTerrain());
    for(let k in this.terrain.takeDirty()) this.markChunkPersist(k);
    this.refreshActivity(true);
    this.terrain.dropPrev(Object.keys(this.terrain.chunks));
    this.game.onWorldChanged();
    this.chunkDelta = null;
    this.broadcast(JSON.stringify(this.fullUpdate()));
    this.world.takeDirty();
    await this.persist();
    if(this.game.active) await this.savePristine();
    console.log(`import: ${Object.keys(this.terrain.chunks).length} chunks, ${shed} fragment(s) shed, ${Object.keys(this.physics.chunkActors).length} chunk colliders${this.game.active ? ', Fort War on' : ''}`);
  }

  // ---- messages -----------------------------------------------------------

  /** @param {Connection} sender @param {string | ArrayBuffer | ArrayBufferView} message */
  async onMessage(sender, message) {
    if(!this.ready || typeof message !== 'string' || !message.startsWith("{")) return;
    let data; try { data = JSON.parse(message); } catch { return; }
    let w = this.world;
    let me = sender.id;
    if(await this.game.onMessage(me, data)) return; // Fort War messages, and sandbox ones a match forbids

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
        await this.applyCsg(data);
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
        this.broadcast(JSON.stringify({ type: "chat", sender: me, message: String(data.message || '').slice(0, 500) }));
        break;
      case "reset":
        await this.reset();
        break;
      case "setgravity":
        await this.setGravity(data.gravity);
        break;
      case "import_begin": await this.importBegin(data); break;
      case "import_chunks": this.importChunks(data); break;
      case "import_end": await this.importEnd(); break;
      default:
        console.error("Unknown message type: " + data.type);
    }
  }
}

/** The Worker: room traffic (/parties/main/<room>/...) goes to the Durable Object, everything else is a static asset. */
export default {
  async fetch(request, env, ctx) {
    let url = new URL(request.url);
    // Chunk bytes are immutable per version: repeats are served from the edge cache, not the room
    if(request.method === 'GET' && url.searchParams.has('v') && /\/parties\/main\/[^/]+\/chunk\//.test(url.pathname)) {
      let cache = caches.default;
      let hit = await cache.match(request);
      if(hit) return hit;
      let res = await routePartykitRequest(request, env);
      if(res && res.status === 200 && (res.headers.get('Cache-Control') || '').includes('immutable')) ctx.waitUntil(cache.put(request, res.clone()));
      return res || new Response('Not found', { status: 404 });
    }
    if(url.pathname === '/api/discord/token') return discordToken(request, env);
    return (await routePartykitRequest(request, env)) || env.ASSETS.fetch(request);
  }
};

/** Discord Activity sign-in: the client trades the OAuth2 code it got from the Embedded App SDK for an access
 *  token here, where the app's client secret lives (`wrangler secret put DISCORD_CLIENT_SECRET`). The client id
 *  comes from the proxy hostname the activity runs under unless DISCORD_CLIENT_ID is set. */
async function discordToken(request, env) {
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if(request.method !== 'POST') return json({ error: 'POST a {code}' }, 405);
  if(!env.DISCORD_CLIENT_SECRET) return json({ error: 'DISCORD_CLIENT_SECRET is not configured on the Worker' }, 501);
  let body = await request.json().catch(() => ({}));
  let client_id = env.DISCORD_CLIENT_ID || body.client_id;
  if(!body.code || !client_id) return json({ error: 'code and client_id are required' }, 400);
  let res = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code: body.code }),
  });
  if(!res.ok) return json({ error: `Discord token exchange failed (${res.status})` }, 502);
  let { access_token } = await res.json();
  return json({ access_token });
}
