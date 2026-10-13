/**
 * Minimal ECS shared by the PartyKit server and the browser client.
 *
 * Design goals (see docs/ecs.md):
 *  - Entities are documents: an id plus a bag of plain-JSON components. The
 *    same serialization is used for network replication, durable storage,
 *    and (later) migrating an entity between host Durable Objects.
 *  - Transient components (names starting with '$') hold runtime handles
 *    (PhysX actors, three.js meshes, interpolation state). They are never
 *    serialized and are rebuilt by systems on whichever host the entity lands.
 *  - Change tracking is per (entity, component) so replication only ships
 *    what changed. Systems are plain objects with update(world, dt).
 */
export class World {
    constructor() {
        /** @type {Map<string, Map<string, any>>} id -> (component name -> data) */
        this.entities = new Map();
        /** @type {Map<string, Set<string>>} id -> dirty component names */
        this.dirty = new Map();
        /** @type {Set<string>} ids destroyed since the last takeDirty() */
        this.removed = new Set();
        /** @type {Map<string, Set<string>>} query signature -> matching ids */
        this.queryCache = new Map();
        this.systems = [];
        this.listeners = { set: [], remove: [], destroy: [] };
        this.nextId = 1;
    }

    // ---- events -----------------------------------------------------------
    on(event, fn) { this.listeners[event].push(fn); return () => { let i = this.listeners[event].indexOf(fn); if(i >= 0) this.listeners[event].splice(i, 1); }; }
    emit(event, ...args) { for(let fn of this.listeners[event]) fn(...args); }

    // ---- entities ---------------------------------------------------------
    /** Create an entity. `id` is optional; `components` is {name: data}. */
    create(id, components = {}) {
        if(id === undefined || id === null) id = 'e' + (this.nextId++);
        else if(typeof id === 'object') { components = id; id = 'e' + (this.nextId++); }
        if(this.entities.has(id)) throw new Error('entity exists: ' + id);
        this.entities.set(id, new Map());
        this.removed.delete(id);
        for(let name in components) this.add(id, name, components[name]);
        return id;
    }

    has(id, name) {
        let e = this.entities.get(id);
        return name === undefined ? !!e : !!(e && e.has(name));
    }

    destroy(id) {
        let e = this.entities.get(id);
        if(!e) return false;
        for(let name of [...e.keys()]) this.remove(id, name);
        this.entities.delete(id);
        this.dirty.delete(id);
        this.removed.add(id);
        this.emit('destroy', id);
        return true;
    }

    /** Ids of all entities. */
    ids() { return this.entities.keys(); }

    // ---- components -------------------------------------------------------
    /** Add (or replace) a component. Returns the stored data object. */
    add(id, name, data = {}) {
        let e = this.entities.get(id);
        if(!e) throw new Error('no entity: ' + id);
        let existed = e.has(name);
        e.set(name, data);
        if(!existed) this._invalidate(name);
        this._markDirty(id, name);
        this.emit('set', id, name, data);
        return data;
    }

    get(id, name) {
        let e = this.entities.get(id);
        return e ? e.get(name) : undefined;
    }

    /** Shallow-merge `patch` into an existing component (adds it if missing). */
    set(id, name, patch) {
        let e = this.entities.get(id);
        if(!e) throw new Error('no entity: ' + id);
        let data = e.get(name);
        if(!data) return this.add(id, name, patch);
        Object.assign(data, patch);
        this._markDirty(id, name);
        this.emit('set', id, name, data);
        return data;
    }

    /** Mark a component dirty without changing it (for in-place mutation). */
    touch(id, name) {
        if(this.has(id, name)) this._markDirty(id, name);
    }

    remove(id, name) {
        let e = this.entities.get(id);
        if(!e || !e.has(name)) return false;
        let data = e.get(name);
        e.delete(name);
        this._invalidate(name);
        this.emit('remove', id, name, data);
        if(!World.isTransient(name)) {
            // A removed persistent component is replicated as `null`.
            this._markDirty(id, name);
        }
        return true;
    }

    /** All components of an entity as a plain object (includes transient). */
    components(id) {
        let e = this.entities.get(id);
        if(!e) return undefined;
        let out = {};
        for(let [k, v] of e) out[k] = v;
        return out;
    }

    // ---- queries ----------------------------------------------------------
    /** Set of entity ids having all the named components. Cached; do not mutate. */
    query(...names) {
        let key = names.join('|');
        let cached = this.queryCache.get(key);
        if(cached) return cached;
        let result = new Set();
        for(let [id, e] of this.entities) {
            let ok = true;
            for(let n of names) if(!e.has(n)) { ok = false; break; }
            if(ok) result.add(id);
        }
        this.queryCache.set(key, result);
        return result;
    }

    /** Iterate [id, compA, compB, ...] for entities having all the components. */
    *each(...names) {
        for(let id of [...this.query(...names)]) {
            let e = this.entities.get(id);
            if(!e) continue;
            let row = [id];
            let ok = true;
            for(let n of names) { let c = e.get(n); if(c === undefined) { ok = false; break; } row.push(c); }
            if(ok) yield row;
        }
    }

    /** First entity id matching a predicate over a component, or undefined. */
    find(name, pred) {
        for(let id of this.query(name)) if(pred(this.entities.get(id).get(name), id)) return id;
        return undefined;
    }

    _invalidate(name) {
        for(let key of [...this.queryCache.keys()]) {
            if(key === name || key.split('|').includes(name)) this.queryCache.delete(key);
        }
    }

    // ---- systems ----------------------------------------------------------
    addSystem(system) { this.systems.push(system); if(system.init) system.init(this); return system; }
    update(dt) { for(let s of this.systems) s.update(this, dt); }

    // ---- change tracking --------------------------------------------------
    static isTransient(name) { return name.charCodeAt(0) === 36; /* '$' */ }

    _markDirty(id, name) {
        if(World.isTransient(name)) return;
        let set = this.dirty.get(id);
        if(!set) { set = new Set(); this.dirty.set(id, set); }
        set.add(name);
    }

    hasDirty() { return this.dirty.size > 0 || this.removed.size > 0; }

    /**
     * Drain the dirty set. Returns { entities: {id: {comp: data | null}}, removed: [ids] }
     * suitable for a partial update. `filter(id, name)` can exclude components.
     */
    takeDirty(filter) {
        let entities = {};
        for(let [id, names] of this.dirty) {
            let e = this.entities.get(id);
            if(!e) continue;
            let out = null;
            for(let name of names) {
                if(filter && !filter(id, name)) continue;
                if(!out) out = {};
                out[name] = e.has(name) ? e.get(name) : null;
            }
            if(out) entities[id] = out;
        }
        let removed = [...this.removed];
        this.dirty.clear();
        this.removed.clear();
        return { entities, removed };
    }

    // ---- serialization ----------------------------------------------------
    /** Persistent components of one entity as a plain object. */
    serializeEntity(id, filter) {
        let e = this.entities.get(id);
        if(!e) return undefined;
        let out = {};
        for(let [name, data] of e) {
            if(World.isTransient(name)) continue;
            if(filter && !filter(id, name)) continue;
            out[name] = data;
        }
        return out;
    }

    /** All entities as {id: {comp: data}}. `filter(id, name)` is optional. */
    serialize(filter) {
        let out = {};
        for(let id of this.entities.keys()) {
            let s = this.serializeEntity(id, filter);
            if(s && Object.keys(s).length > 0) out[id] = s;
        }
        return out;
    }

    /**
     * Apply a snapshot produced by serialize()/takeDirty(). Creates missing
     * entities, sets listed components, deletes components sent as null.
     * With `full: true`, entities absent from the snapshot are destroyed
     * (except those for which `keep(id)` returns true).
     */
    applySnapshot(entities, { full = false, removed = [], keep = null } = {}) {
        for(let id of removed) this.destroy(id);
        for(let id in entities) {
            if(!this.entities.has(id)) this.create(id);
            let comps = entities[id];
            for(let name in comps) {
                if(comps[name] === null) this.remove(id, name);
                else this.add(id, name, comps[name]);
            }
        }
        if(full) {
            for(let id of [...this.entities.keys()]) {
                if(!(id in entities) && !(keep && keep(id))) this.destroy(id);
            }
        }
    }
}
