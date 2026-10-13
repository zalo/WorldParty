/* eslint-env browser */
// @ts-check
/** @typedef {import("partykit/server").Room} Room */
/** @typedef {import("partykit/server").Server} Server */
/** @typedef {import("partykit/server").Connection} Connection */
/** @typedef {import("partykit/server").ConnectionContext} ConnectionContext */

import { World } from './ecs/World.js';
import { Transform, RigidBody, Prop, Joint, Grabbed, Player, Model, PERSISTED } from './ecs/components.js';
import { Physics } from './server/Physics.js';
import { Terrain, CHUNK_COUNT, chunkCenter } from './server/Terrain.js';
import { getPropDef } from './props/PropRegistry.js';
import { packChunkFrame } from './net/codec.js';

const TICK_MS = 1000 / 30;
const FULL_UPDATE_EVERY = 300;      // ticks (10s)
const PERSIST_INTERVAL_MS = 5000;
const STORAGE_BATCH = 128;          // Durable Object storage batch limit

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
    let [storedChunks, storedEntities] = await Promise.all([this.loadPrefixed('chunk:'), this.loadPrefixed('ent:')]);
    // Legacy single-blob layout
    let legacyChunks = await this.room.storage.get("chunks");
    if(legacyChunks) { Object.assign(storedChunks, legacyChunks); await this.room.storage.delete("chunks"); }

    await this.terrain.init(storedChunks);
    await this.physics.init();
    this.rebuildAllChunkColliders();

    let maxId = 0;
    for(let id in storedEntities) {
      this.world.create(id, storedEntities[id]);
      let m = /^e(\d+)$/.exec(id); if(m) maxId = Math.max(maxId, parseInt(m[1]));
    }
    this.world.nextId = maxId + 1;
    this.world.takeDirty(); // loaded state is not "changed"
    this.persistQueue.clear(); this.persistRemoved.clear();
    // Chunks loaded from the legacy soup format are re-encoded and flagged for re-persist
    for(let k in this.terrain.takeDirty()) this.markChunkPersist(parseInt(k));
    this.ready = true;
    this.resolveReady();
    console.log(`World ready: ${Object.keys(storedChunks).length} chunks, ${Object.keys(storedEntities).length} entities, ${Object.keys(this.physics.chunkActors).length} chunk colliders`);
  }

  async loadPrefixed(prefix) {
    let out = {};
    let map = await this.room.storage.list({ prefix });
    for(let [key, value] of map) out[key.slice(prefix.length)] = value;
    return out;
  }

  /** Colliders for every stored chunk plus every unmodified solid chunk that is at least
   *  partly exposed. Fully buried rock gets nothing: no body can reach it. */
  rebuildAllChunkColliders() {
    for(let index in this.physics.chunkActors) this.physics._removeChunkActor(index);
    for(let index of this.terrain.exposedDefaults()) this.ensureDefaultCollider(index);
    for(let index in this.terrain.chunks) this.physics.setChunkCollider(parseInt(index), this.terrain.chunkMesh(parseInt(index)));
  }

  ensureDefaultCollider(index) {
    if(this.physics.chunkActors[index]) return;
    let c = chunkCenter(index);
    this.physics.setDefaultChunkCollider(index, c.x, c.y, c.z);
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
    if(players === 0 && !this.anyAwake && !this.world.hasDirty() && this.terrain.dirty.size === 0) {
      this.physics.lastTime = start;
      return;
    }

    this.anyAwake = this.physics.update(this.world, TICK_MS / 1000);
    this.tickCount++;

    if(players > 0) {
      if(this.tickCount % FULL_UPDATE_EVERY === 0) {
        this.room.broadcast(JSON.stringify(this.fullUpdate()));
        this.world.takeDirty(); this.terrain.takeDirty();
      } else if(this.world.hasDirty() || this.terrain.dirty.size > 0) {
        let { entities, removed } = this.world.takeDirty();
        this.room.broadcast(JSON.stringify({ type: "partialupdate", entities, removed, chunks: this.terrain.takeDirty(), serverTickMs: this.serverTickMs }));
      }
    }

    if(start - this.lastPersist > PERSIST_INTERVAL_MS) this.persist();
    this.serverTickMs = Date.now() - start;
  }

  fullUpdate() {
    return { type: "fullupdate", entities: this.world.serialize(), removed: [], chunks: this.terrain.versions(), serverTickMs: this.serverTickMs };
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
    for(let index of this.persistChunks || []) { let c = this.terrain.serializeChunk(index); if(c) puts['chunk:' + index] = c; }
    this.persistQueue.clear(); this.persistRemoved.clear(); this.persistChunks = new Set();

    let keys = Object.keys(puts);
    for(let i = 0; i < keys.length; i += STORAGE_BATCH) {
      let batch = {};
      for(let k of keys.slice(i, i + STORAGE_BATCH)) batch[k] = puts[k];
      await this.room.storage.put(batch);
    }
    for(let i = 0; i < deletes.length; i += STORAGE_BATCH) await this.room.storage.delete(deletes.slice(i, i + STORAGE_BATCH));
  }

  markChunkPersist(index) { (this.persistChunks ||= new Set()).add(index); }

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
    let fragments = this.terrain.applyCsg(data);
    let changed = this.terrain.takeDirty();
    for(let key in changed) {
      let index = parseInt(key);
      this.physics.setChunkCollider(index, this.terrain.chunkMesh(index));
      // Rock next to a modified chunk may now be reachable through it
      for(let n of this.terrain.defaultNeighbours(index)) this.ensureDefaultCollider(n);
      this.markChunkPersist(index);
      // Push the new bytes to everyone now; later joiners fetch by version over HTTP.
      let c = this.terrain.chunks[index];
      this.room.broadcast(packChunkFrame(index, c.version, c.bytes));
    }
    for(let comps of fragments) this.world.create(comps);
    let n = Object.keys(changed).length;
    if(n) console.log(`csg: ${n} chunk(s) changed, ${fragments.length} fragment(s), ${Object.keys(this.physics.chunkActors).length} chunk colliders`);
  }

  /** HTTP: GET /parties/main/<room>/chunk/<index>?v=<version> -> chunk bytes (204 if empty). */
  async onRequest(req) {
    await this.readyPromise;
    let url = new URL(req.url);
    let m = /\/chunk\/(\d+)$/.exec(url.pathname);
    if((req.method !== "GET" && req.method !== "HEAD") || !m) return new Response("Not found", { status: 404 });
    let index = parseInt(m[1]);
    if(index < 0 || index >= CHUNK_COUNT) return new Response("Bad chunk", { status: 400 });
    let c = this.terrain.chunks[index];
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

  async reset() {
    for(let id of [...this.world.ids()]) if(!this.world.has(id, 'Player')) this.world.destroy(id);
    this.terrain.clear();
    let keys = [...(await this.room.storage.list({ prefix: 'chunk:' })).keys(), ...(await this.room.storage.list({ prefix: 'ent:' })).keys()];
    for(let i = 0; i < keys.length; i += STORAGE_BATCH) await this.room.storage.delete(keys.slice(i, i + STORAGE_BATCH));
    this.persistQueue.clear(); this.persistRemoved.clear(); this.persistChunks = new Set();
    this.rebuildAllChunkColliders();
    this.room.broadcast(JSON.stringify(this.fullUpdate()));
    this.world.takeDirty();
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
      default:
        console.error("Unknown message type: " + data.type);
    }
  }
}

export default PartyServer;
