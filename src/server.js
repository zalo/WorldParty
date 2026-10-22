/* eslint-env browser */
// @ts-check
/** @typedef {import("partyserver").Connection} Connection */
/** @typedef {import("partyserver").ConnectionContext} ConnectionContext */

import { Server, routePartykitRequest } from 'partyserver';
import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
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
import { packChunkFrame, packChunkDeltaFrame, encodeChunkDelta, decodeSoup, encodeSoup, encodeHulls, gzipAsync, EMPTY_VERSION } from './net/codec.js';

const TICK_MS = 1000 / 30;
const FULL_UPDATE_EVERY = 300;      // ticks (10s)
const PERSIST_INTERVAL_MS = 5000;
const STORAGE_BATCH = 128;          // Durable Object storage batch limit
const STORAGE_PART = 100 * 1024;    // chunk bytes above this are split across chunkpart:<key>:<i> values (128 KiB value limit)
const COOKS_NOW = 3;                // mesh colliders cooked immediately when activity changes (nearest first) ...
const COOKS_PER_TICK = 2;           // ... and per tick for the rest
const SPECULATION_TRIS = 60_000;    // triangles of speculated craters (speculateBlast) held at once, outside the resident budget
/** How a blast throws the rock it breaks (throwShards): m/s for a 2.4 m blast (a rocket's; more for bigger ones; under
 *  the bodies' 30 m/s² it takes 9.5 m/s to climb out of a 1.5 m crater, and 6-12 left most of them in it), how much
 *  of the way out it adds to the line from the centre, spin in rad/s, and how long a shard hurts no one. */
const SHARD_THROW = { speed: [10, 17], lift: 1.2, spin: 8, safeMs: 1500 };
const REBAKE_GROW = 0.025;          // m a body grows by when it is baked back into the terrain (rebake)

// Brushes the server carves with itself (the drill, the mason; explosions build their own, carveBlast): unit shapes, scaled per use
/** The drill's brush: the convex hull of two unit spheres (320-face icospheres, so its tunnels read as round) whose
 *  centres lie `length` apart on z, centred on the origin. Cached per length (in radii). */
const CAPSULE_SOUPS = new Map();
function capsuleSoup(length) {
  let k = length.toFixed(3);
  if(!CAPSULE_SOUPS.has(k)) {
    let ball = new THREE.IcosahedronGeometry(1, 2).attributes.position, points = [];
    for(let z of [-length / 2, length / 2]) for(let i = 0; i < ball.count; i++) points.push(new THREE.Vector3(ball.getX(i), ball.getY(i), ball.getZ(i) + z));
    CAPSULE_SOUPS.set(k, encodeSoup(new ConvexGeometry(points).attributes.position.array));
  }
  return CAPSULE_SOUPS.get(k);
}
const CUBE_SOUP = encodeSoup(new THREE.BoxGeometry(1, 1, 1).toNonIndexed().attributes.position.array);

const RESUME_MS = 60000;            // a dropped connection that comes back within this long carries on as the same player
const PERF_KEEP = 300;              // client perf reports kept for GET .../perf (see recordPerf)
/** What a client perf report may carry (src/client/PerfReport.js): n = number, s = short string, b = boolean. */
const PERF_FIELDS = { fps: 'n', frameMax: 'n', hitches: 'n', ping: 'n', pingMax: 'n', reconnects: 'n', spikes: 'n', spikeMax: 'n', holds: 'n', holdMs: 'n', deltaMiss: 'n', teleports: 'n', locks: 'n', raw: 'b', backend: 's', gpu: 's', client: 's', size: 's', dpr: 'n', mobile: 'b', discord: 'b' };
const PLAYER_COLORS = ["#FF0000", "#0000FF", "#FFFF00", "#FF00FF", "#00FFFF", "#FF8000", "#FF0080", "#8000FF", "#0080FF", "#80FF00", "#00FF80", "#FF8080", "#8080FF", "#FF80FF", "#80FFFF", "#FFFF80"];

const overlaps = (box, p, r) => p.x + r > box.min.x && p.x - r < box.max.x && p.y + r > box.min.y && p.y - r < box.max.y && p.z + r > box.min.z && p.z - r < box.max.z;
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
    this.rebakeBoxes = [];          // bounds of the bodies baked into the terrain since the last settleNow (rebake)
    this.csgStats = { ops: 0, booleanMs: 0, shardMs: 0, deltaBytes: 0, fullBytes: 0 };
    this.speculatedTris = 0;        // held by speculations not yet made or dropped (SPECULATION_TRIS)
    this.persistChunkDeletes = new Set();
    this.chunkParts = new Map();    // key -> number of chunkpart values currently stored
    this.ready = false;
    this.readyPromise = new Promise(res => { this.resolveReady = res; });
    this.globalPlayerCount = 0;
    this.tickCount = 0;
    this.serverTickMs = 0;          // how long the last tick took (only meaningful in Node: on Cloudflare the clock stands still during a tick)
    this.serverGapMs = 0;           // the longest gap between two tick starts over the last second, sent to clients: how late the server runs
    this.gapWindow = 0; this.gapTicks = 0;
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
    this.lingering = new Map();     // connection id -> { Player, Transform, round, at }: a dropped player, resumed if the id reconnects within RESUME_MS
    this.perfLog = null;            // recent client perf reports (loaded from storage on first use)
    this.tickGapMax = 0;            // longest wall-clock gap between two ticks since the last perf report (the event loop was busy)
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
          if(comps) {
            // rubble baked back into the terrain that came loose again at once rested on a body, not on terrain: it
            // would be baked and shed over and over, so it stays a body (and fades)
            if(this.rebakeBoxes.some(b => overlaps(b, comps.Transform.position, comps.RigidBody.halfExtent))) comps.FragmentMesh.rebake = false;
            this.world.create(comps); made++;
          }
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
    // A client reconnecting with the same id before its old socket closed must not fail with "entity exists"
    if(this.world.has(conn.id)) this.onDisconnect(this.conns.get(conn.id) || conn);
    this.conns.set(conn.id, conn);
    // A dropped socket comes back with the same id (PartySocket keeps it): the player carries on where they were, same
    // team and score, no spawn teleport (that snapped a player back to their spawn on every network blip and deploy)
    let resume = this.lingering.get(conn.id);
    this.lingering.delete(conn.id);
    if(resume && Date.now() - resume.at > RESUME_MS) resume = null;
    if(!resume) this.globalPlayerCount += 1;
    this.world.create(conn.id, resume ? { Player: resume.Player, Transform: resume.Transform } : {
      Player: Player({ name: "Player " + this.globalPlayerCount, color: PLAYER_COLORS[this.globalPlayerCount % PLAYER_COLORS.length] }),
      Transform: Transform(),
    });
    conn.send(JSON.stringify(this.fullUpdate()));
    if(resume) this.game.onResume(conn.id, resume.round);
    else this.game.onConnect(conn.id); // team and spawn point follow in the next partial update
    console.log(`${resume ? `Resumed after ${((Date.now() - resume.at) / 1000).toFixed(1)} s` : 'Connected'}: ${conn.id} room: ${this.name} url: ${new URL(ctx.request.url).pathname}`);
  }

  /** @param {Connection} conn */
  onDisconnect(conn) {
    if(this.conns.has(conn.id) && this.conns.get(conn.id) !== conn) return; // a replaced socket closing late: its player is back on the new one
    this.conns.delete(conn.id);
    if(!this.world.has(conn.id)) return;
    // Drop anything this player was holding, then the player itself (kept aside a while in case the socket comes back)
    this.game.onDisconnect(conn.id);
    for(let [id, g] of this.world.each('Grabbed')) if(g.by === conn.id) this.world.remove(id, 'Grabbed');
    let now = Date.now();
    for(let [id, l] of this.lingering) if(now - l.at > RESUME_MS) this.lingering.delete(id);
    this.lingering.set(conn.id, { Player: structuredClone(this.world.get(conn.id, 'Player')), Transform: structuredClone(this.world.get(conn.id, 'Transform')), round: this.game.round(), at: now });
    this.world.destroy(conn.id);
    this.persist().catch(e => console.error('persist failed: ' + e.message));
  }
  onClose(conn) { this.onDisconnect(conn); }
  onError(conn, error) { console.error(error); this.onDisconnect(conn); }

  // ---- tick ---------------------------------------------------------------

  tick() {
    if(!this.ready) return;
    let start = Date.now();
    // the clock does advance between events, so the spacing of ticks shows a busy event loop (a carve, a settle)
    let gap = this.lastTickAt ? start - this.lastTickAt : 0;
    this.lastTickAt = start;
    this.tickGapMax = Math.max(this.tickGapMax, gap);
    this.gapWindow = Math.max(this.gapWindow, gap);
    if(++this.gapTicks >= 30) { this.serverGapMs = this.gapWindow; this.gapWindow = 0; this.gapTicks = 0; }
    let players = this.world.query('Player').size;

    // Nothing to simulate: no players and everything asleep
    if(players === 0 && !this.anyAwake && !this.world.hasDirty() && !this.chunkDelta && !this.cookQueue.size) {
      this.physics.lastTime = start;
      return;
    }

    this.pumpCooks(COOKS_PER_TICK);
    this.releaseThrown();
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
        this.broadcast(JSON.stringify({ type: "partialupdate", entities, removed, chunks: d.chunks, rock: d.rock, cull: d.cull, serverTickMs: this.serverTickMs, serverGapMs: this.serverGapMs }));
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
    return { type: "fullupdate", entities, removed: [], world: this.terrain.world, ...this.chunkMaps(), serverTickMs: this.serverTickMs, serverGapMs: this.serverGapMs };
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

  /** Server-side carves: `by` is the player responsible (Fort War credits them with the crystals it frees).
   *  A blast of radius `radius`: a crater of flat broken facets (Shatter.js) rather than a sphere, reaching less far
   *  into hard material, its faces taking the material of what they cut (`fallback` where nothing says). The crater
   *  stays within 1.3 radii of the centre (the cells' bounding cube). What it breaks out is thrown as rubble
   *  (Terrain.blastShards, throwShards). */
  carveBlast(center, radius, fallback = 1, by = null) {
    let R = radius * 1.3, min = { x: center.x - R, y: center.y - R, z: center.z - R }, max = { x: center.x + R, y: center.y + R, z: center.z + R };
    let keys = chunksInBox(this.terrain.world, min, max), shards = null;
    return this.carveWith(keys, () => {
      let T = this.terrain, probe = T.solidProbe(keys, min, max), cells = [];
      let brush = T.blastBrush(center, radius, probe, fallback, cells);
      if(brush) shards = this.blastShards(keys, cells, center, R, probe, fallback);
      return brush;
    }, { min, max }, by).then(() => this.throwShards(shards, center, radius));
  }
  /** Terrain.blastShards, and a blast that cannot work out its shards still carves. */
  blastShards(keys, cells, center, reach, probe, fallback) {
    let t0 = Date.now();
    try { return this.terrain.blastShards(keys, cells, center, reach, probe, fallback); }
    catch(e) { console.warn('shards failed: ' + e.message); return null; }
    finally { this.csgStats.shardMs += Date.now() - t0; }
  }
  /** Throw the pieces a blast broke loose out of its crater: along the line from the blast's centre plus `lift` times
   *  the side it vents to (a crater in the ground throws up and out; a piece under the centre goes straight up rather
   *  than into the floor; a buried blast throws them inward, into the hollow it made), spinning, faster for a bigger
   *  blast. The blast has hurt everyone near already, so a shard hurts no one on its way out ($Thrown.until;
   *  Game.rubbleSystem). Physics.bodySystem gives the new bodies `v` and `w`. */
  throwShards(shards, center, radius) {
    if(!shards || !shards.pieces.length) return;
    let now = Date.now(), k = Math.min(1.6, Math.sqrt(radius / 2.4)), o = shards.open;
    let unit = (v) => { let l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };
    for(let comps of shards.pieces) {
      let p = comps.Transform.position;
      let d = unit({ x: p.x - center.x, y: p.y - center.y, z: p.z - center.z });
      let dir = o ? unit({ x: d.x + o.x * SHARD_THROW.lift, y: d.y + o.y * SHARD_THROW.lift, z: d.z + o.z * SHARD_THROW.lift })
        : unit({ x: -d.x + Math.random() - 0.5, y: -d.y + Math.random() - 0.5, z: -d.z + Math.random() - 0.5 });
      let speed = (SHARD_THROW.speed[0] + Math.random() * (SHARD_THROW.speed[1] - SHARD_THROW.speed[0])) * k;
      let spin = unit({ x: Math.random() - 0.5, y: Math.random() - 0.5, z: Math.random() - 0.5 }), w = Math.random() * SHARD_THROW.spin;
      this.world.create({ ...comps, $Thrown: { v: { x: dir.x * speed, y: dir.y * speed, z: dir.z * speed }, w: { x: spin.x * w, y: spin.y * w, z: spin.z * w }, until: now + SHARD_THROW.safeMs, hold: true } });
    }
  }
  /** A blast's shards get their bodies (Physics.bodySystem skips them while `hold`) once the carve has settled and the
   *  colliders of the chunks they reach are the crater's: the cook queue does a few chunks a tick, and a shard created
   *  against the old ground starts inside it and never leaves. */
  releaseThrown() {
    if(this.settleTimer) return; // the crater is not settled yet
    for(let [, t, tf, rb] of this.world.each('$Thrown', 'Transform', 'RigidBody')) {
      if(!t.hold) continue;
      t.hold = false;
      let p = tf.position, r = rb.halfExtent + 0.5;
      for(let key of chunksInBox(this.terrain.world, { x: p.x - r, y: p.y - r, z: p.z - r }, { x: p.x + r, y: p.y + r, z: p.z + r })) {
        if(!this.cookQueue.has(key)) continue;
        let v = this.cookQueue.get(key);
        this.cookQueue.delete(key);
        if(this.colliderState.get(key) === 'mesh:' + v) this.physics.setChunkCollider(key, this.terrain.chunkMesh(key));
      }
    }
  }
  /** The blast carveBlast would make, worked out now but not made (a rocket's crater, when it is fired: Game.precarve).
   *  Resolves to { results, frames, box, center } or null: `frames` are its chunks as `ahead` frames (a delta against the
   *  version clients hold, else in full), for clients to hold until the explosion; `commitBlast` makes it when the
   *  rocket lands, if nothing changed those chunks meanwhile, else `dropSpeculation` frees it. */
  async speculateBlast(center, radius, fallback = 1) {
    if(this.speculatedTris > SPECULATION_TRIS) return null;
    let R = radius * 1.3, min = { x: center.x - R, y: center.y - R, z: center.z - R }, max = { x: center.x + R, y: center.y + R, z: center.z + R };
    let keys = chunksInBox(this.terrain.world, min, max), T = this.terrain;
    await T.prepare(keys);
    let t0 = Date.now(), brush = null, results, probe = null, cells = [];
    try { probe = T.solidProbe(keys, min, max); brush = T.blastBrush(center, radius, probe, fallback, cells); } catch(e) { console.warn('brush failed: ' + e.message); }
    if(!brush) return null;
    let shards = this.blastShards(keys, cells, center, R, probe, fallback); // (plain data: nothing to free if it is dropped)
    try { results = T.speculate(keys, brush); } finally { brush.delete(); }
    let frames = [], spec = { results, frames, box: { min, max }, center, radius, shards, tris: 0 };
    for(let key in results) {
      let r = results[key], frame = null;
      spec.tris += r.tris;
      if(r.base !== null && r.version !== EMPTY_VERSION && this.sentStates.get(key)?.version === r.base) { // (else clients do not hold its base)
        let delta = encodeChunkDelta(T.currentMesh(key), r.mesh);
        if(delta.length < r.raw.length * 0.45) frame = packChunkDeltaFrame(key, r.version, r.base, delta, true); // (pushChunk's rule: under 3/4 of the gzip, ~60% of raw)
      }
      frames.push(frame || packChunkFrame(key, r.version, r.raw ? await gzipAsync(r.raw) : null, true));
    }
    this.speculatedTris += spec.tris;
    this.csgStats.booleanMs += Date.now() - t0;
    return spec;
  }
  /** Make a speculated blast; false (and nothing done) if one of its chunks is no longer the version it read. Its
   *  frames went out ahead, so the chunks are not pushed again. */
  commitBlast(spec, by) {
    let T = this.terrain;
    for(let key in spec.results) if((T.chunks[key] ? T.chunks[key].version : null) !== spec.results[key].base) return false;
    for(let key in spec.results) { let r = spec.results[key]; T.install(key, r); this.pushed.set(key, r.version); }
    this.speculatedTris -= spec.tris;
    spec.results = {}; spec.tris = 0; // the terrain owns the manifolds now
    this.afterCsg(spec.box, by);
    this.throwShards(spec.shards, spec.center, spec.radius);
    spec.shards = null;
    return true;
  }
  dropSpeculation(spec) {
    for(let key in spec.results) spec.results[key].manifold?.delete();
    this.speculatedTris -= spec.tris;
    spec.results = {}; spec.tris = 0;
  }
  /** What clients should hold of these chunks (the wire states last sent), as update maps. */
  sentMaps(keys) {
    let chunks = {}, rock = {}, cull = {};
    for(let key of keys) {
      let st = this.sentStates.get(key);
      if(st && st.version !== undefined) { chunks[key] = st.version; cull[key] = st.cull; rock[key] = 0; }
      else { chunks[key] = null; rock[key] = st ? st.rock : 0; }
    }
    return { chunks, rock, cull };
  }
  /** The convex hull of two spheres of `radius` centred at `a` and `b` (the drill), simplified only to 2 cm, pulled
   *  in where it reaches into hard material (seen from `a`, the sphere around the player) and tagged with what it
   *  cuts, like a blast. */
  carveCapsule(a, b, radius, fallback = 1, by = null) {
    let d = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z), length = d.length();
    let q = length > 1e-6 ? new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), d.divideScalar(length)) : new THREE.Quaternion();
    let center = new THREE.Vector3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    let min = { x: Math.min(a.x, b.x) - radius, y: Math.min(a.y, b.y) - radius, z: Math.min(a.z, b.z) - radius };
    let max = { x: Math.max(a.x, b.x) + radius, y: Math.max(a.y, b.y) + radius, z: Math.max(a.z, b.z) + radius };
    let keys = chunksInBox(this.terrain.world, min, max);
    return this.carveWith(keys, () => {
      let T = this.terrain, probe = T.solidProbe(keys, min, max);
      let brush = T.soupToManifold(capsuleSoup(length / radius), center, q, new THREE.Vector3(radius, radius, radius), 0.02);
      return T.tagBrush(T.harden(brush, a, probe), a, probe, fallback);
    }, { min, max }, by);
  }
  /** Subtract a brush the server builds itself: `make()` runs once the chunks are decoded and returns a world-space
   *  manifold (or null), which is freed afterwards. `box` bounds it (the crystals it can free). */
  async carveWith(keys, make, box, by = null) {
    await this.terrain.prepare(keys);
    let t0 = Date.now(), brush = null;
    try { brush = make(); } catch(e) { console.warn('brush failed: ' + e.message); }
    if(!brush) return;
    try { this.terrain.applyBrush(keys, brush, SUBTRACTION); } finally { brush.delete(); }
    this.csgStats.booleanMs += Date.now() - t0;
    this.afterCsg(box, by);
  }
  /** Sleeping terrain rubble back into the terrain (Fort War's Game.fadeSystem asks): each body's mesh where it lies,
   *  grown by REBAKE_GROW so it overlaps what it rests on (Terrain.posedFragment), all of them in one union added to
   *  the chunks they reach; the bodies go, and it can be dug like the rest. Clients are told the chunk versions that
   *  replace them (`rebake`), so they keep drawing a body until its chunks show it. Rubble the next settle sheds again
   *  rested on something that is not terrain (a crate, a player) and stays a body (rebakeBoxes). */
  async rebake(ids) {
    let w = this.world, T = this.terrain, M = T.manifold.Manifold;
    if(this.importing) return;
    let keys = new Set();
    for(let id of ids) {
      let p = w.get(id, 'Transform').position, r = (w.get(id, 'RigidBody').halfExtent || 0.5) * 1.8 + REBAKE_GROW * 2;
      for(let k of chunksInBox(T.world, { x: p.x - r, y: p.y - r, z: p.z - r }, { x: p.x + r, y: p.y + r, z: p.z + r })) keys.add(k);
      w.add(id, '$Baking', {});
    }
    try { await T.prepare([...keys]); }
    finally { for(let id of ids) if(w.has(id)) w.remove(id, '$Baking'); }
    let t0 = Date.now(), pieces = [], done = [], min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for(let id of ids) {
      if(!w.has(id, 'FragmentMesh')) continue; // gone meanwhile
      let rb = w.get(id, 'RigidBody');
      if(!rb.sleeping || rb.frozen || w.has(id, 'Grabbed')) continue; // woken meanwhile: it comes round again
      let m = T.posedFragment(w.get(id, 'FragmentMesh'), w.get(id, 'Transform'), REBAKE_GROW);
      if(!m) { w.add(id, '$NoBake', {}); continue; } // not a closed solid: it fades instead
      let b = m.boundingBox();
      min = { x: Math.min(min.x, b.min[0]), y: Math.min(min.y, b.min[1]), z: Math.min(min.z, b.min[2]) };
      max = { x: Math.max(max.x, b.max[0]), y: Math.max(max.y, b.max[1]), z: Math.max(max.z, b.max[2]) };
      pieces.push(m); done.push(id);
    }
    if(!pieces.length || this.importing) { for(let m of pieces) m.delete(); return; }
    let brush = pieces.length === 1 ? pieces[0] : M.union(pieces);
    if(pieces.length > 1) for(let m of pieces) m.delete();
    let changed = chunksInBox(T.world, min, max);
    try { T.applyBrush(changed, brush, ADDITION); } finally { brush.delete(); }
    this.csgStats.booleanMs += Date.now() - t0;
    for(let id of done) w.destroy(id);
    let box = { min, max }, chunks = {};
    for(let key of changed) if(T.dirty.has(key)) chunks[key] = T.chunks[key]?.version ?? null;
    this.rebakeBoxes.push(box);
    this.afterCsg(box, null);
    this.broadcast(JSON.stringify({ type: 'rebake', ids: done, chunks }));
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
    let box = null;
    if(data.position && data.scale) { // the brush's bounds, generously: the unit brushes fit a unit sphere or cube (the drill's in 1.41)
      let p = vec3(data.position), s = vec3(data.scale, { x: 1, y: 1, z: 1 }), R = Math.hypot(s.x, s.y, s.z);
      box = { min: { x: p.x - R, y: p.y - R, z: p.z - R }, max: { x: p.x + R, y: p.y + R, z: p.z + R } };
    }
    this.afterCsg(box, data.by ?? null);
  }

  /** After a boolean: remember where it was (the glow rocks it can uncover), push the changed chunks, settle soon. */
  afterCsg(box, by) {
    if(this.terrain.dirty.size === 0) return;
    if(box) this.carveBoxes.push({ min: box.min, max: box.max, by });
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
    this.rebakeBoxes = [];
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
    let st = this.csgStats; this.csgStats = { ops: 0, booleanMs: 0, shardMs: 0, deltaBytes: 0, fullBytes: 0 };
    console.log(`csg: ${st.ops} op(s), ${Object.keys(changed).length} chunk(s) changed, ${fragments} fragment(s), ${Object.keys(this.physics.chunkActors).length} chunk colliders; pushed ${(st.deltaBytes / 1024).toFixed(0)} KB as deltas + ${(st.fullBytes / 1024).toFixed(0)} KB full; boolean+encode ${st.booleanMs}ms${st.shardMs ? ` (shards ${st.shardMs}ms)` : ''}, settle ${settleMs}ms, colliders+activity ${activityMs}ms${rocks ? `; glow rocks: ${rocks.made} new, ${rocks.freed} freed, ${rocks.updated} updated, ${rocks.sky} under the sky (${rocks.measured} measured, ${rocks.rays} rays, ${rocks.bvhBuilds} BVHs) ${rocks.ms}ms` : ''}`);
  }

  /** A client's perf report (src/client/PerfReport.js, every 20 s): logged, and the last PERF_KEEP kept in storage for
   *  GET .../perf, so a player's lag can be looked at after the fact. Only the whitelisted numbers and short strings;
   *  no name, a connection id prefix ties one player's reports together. The server adds its longest tick gap. */
  async recordPerf(id, data) {
    let r = { t: Date.now(), room: this.name, id: String(id).slice(0, 6), tickGapMax: this.tickGapMax, players: this.conns.size };
    this.tickGapMax = 0;
    for(let [k, type] of Object.entries(PERF_FIELDS)) {
      let v = data[k];
      if(type === 'n' && typeof v === 'number' && Number.isFinite(v)) r[k] = Math.round(v * 10) / 10;
      else if(type === 's' && typeof v === 'string') r[k] = v.slice(0, 80);
      else if(type === 'b' && typeof v === 'boolean') r[k] = v;
    }
    console.log('perf ' + JSON.stringify(r));
    if(!this.perfLog) this.perfLog = (await this.ctx.storage.get('perf')) || [];
    this.perfLog.push(r);
    if(this.perfLog.length > PERF_KEEP) this.perfLog.splice(0, this.perfLog.length - PERF_KEEP);
    await this.ctx.storage.put('perf', this.perfLog);
  }

  /** HTTP: GET /parties/main/<room>/chunk/<x,y,z>?v=<version> -> chunk bytes (204 if empty); GET .../perf -> the
   *  recent perf reports (recordPerf). */
  async onRequest(req) {
    await this.readyPromise;
    let url = new URL(req.url);
    if(req.method === "GET" && url.pathname.endsWith('/perf')) {
      if(!this.perfLog) this.perfLog = (await this.ctx.storage.get('perf')) || [];
      return new Response(JSON.stringify(this.perfLog), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
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
    if(data.type === 'ping') { sender.send(JSON.stringify({ type: 'pong', t: data.t })); return; } // the client's ping readout
    if(data.type === 'perf') { await this.recordPerf(me, data); return; }
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
        data.by = me; // what a carve frees is credited to whoever sent it, never to a name in the message
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
    if(url.pathname.startsWith('/assets/music/')) return rangedAsset(request, env);
    return (await routePartykitRequest(request, env)) || env.ASSETS.fetch(request);
  }
};

/** Static assets ignore Range (a 200 with the whole file), and Safari and iOS want byte ranges for <audio>; Discord's
 *  CSP (`default-src 'self'`) rules out the usual way around it, a blob URL. So the music (MusicTrack.js) is served
 *  through here (`run_worker_first`), sliced to the requested range. */
async function rangedAsset(request, env) {
  let headers = new Headers(request.headers), range = headers.get('Range');
  headers.delete('Range');
  let res = await env.ASSETS.fetch(new Request(request.url, { method: request.method, headers }));
  let m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if(request.method !== 'GET' || res.status !== 200 || !m || (m[1] === '' && m[2] === '')) {
    if(res.status !== 200) return res;
    let out = new Response(res.body, res); out.headers.set('Accept-Ranges', 'bytes'); return out;
  }
  let body = await res.arrayBuffer(), size = body.byteLength;
  let start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  let end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if(start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  let out = new Headers(res.headers);
  out.delete('Content-Encoding'); // the body here is the decoded bytes
  out.set('Accept-Ranges', 'bytes'); out.set('Content-Range', `bytes ${start}-${end}/${size}`); out.set('Content-Length', String(end - start + 1));
  return new Response(body.slice(start, end + 1), { status: 206, headers: out });
}

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
