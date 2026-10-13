/** Server-side terrain: a sparse map of CSG-modified chunks backed by
 *  Manifold (WASM). Unmodified chunks are implicit: solid 10m boxes below
 *  y=5, empty above. Chunks are indexed x*100 + y*10 + z over a 10x10x10 grid
 *  centred on the origin.
 *
 *  This module owns the mesh data; colliders live in Physics and fragment
 *  bodies are ECS entities created by the caller from fragmentComponents(). */
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ADDITION, INTERSECTION, SUBTRACTION } from 'three-bvh-csg';
import { M } from '../../assets/manifold-3d/manifold.js';
import manMod from '../../assets/manifold-3d/manifold.wasm';
import { encodeSoup, decodeSoup } from '../net/codec.js';
import { Transform, RigidBody, FragmentMesh } from '../ecs/components.js';

export const GRID = 10;
export const CHUNK_SIZE = 10.0;
export const SOLID_BELOW_Y = 5;

export function chunkCoords(index) {
    return { x: Math.floor(index / 100), y: Math.floor(index / 10) % 10, z: index % 10 };
}
export function chunkCenter(index) {
    let c = chunkCoords(index);
    return { x: c.x * CHUNK_SIZE - 45.0, y: c.y * CHUNK_SIZE - 45.0, z: c.z * CHUNK_SIZE - 45.0 };
}

export class Terrain {
    constructor() {
        /** @type {Record<number, { index:number, data:string, manifold:any }>} */
        this.chunks = {};
        /** @type {Set<number>} chunk indices changed since last takeDirty() */
        this.dirty = new Set();
        this.manifold = null;
    }

    async init(storedChunks = {}) {
        this.manifold = await M({
            instantiateWasm: (imports, callback) => {
                const instance = new WebAssembly.Instance(manMod, imports);
                callback(instance);
                return instance.exports;
            }
        });
        this.manifold.setup();
        for(let key in storedChunks) {
            let c = storedChunks[key];
            this.chunks[c.index] = { index: c.index, data: c.data, manifold: this.soupToManifold(c.data) };
        }
    }

    /** True if the chunk has terrain (either implicit solid or a stored manifold). */
    hasTerrain(index) {
        let c = this.chunks[index];
        if(c) return !!c.manifold;
        return chunkCoords(index).y < SOLID_BELOW_Y;
    }

    /** Serializable chunk map for storage and full updates. */
    serialize() {
        let out = {};
        for(let key in this.chunks) out[key] = { index: this.chunks[key].index, data: this.chunks[key].data };
        return out;
    }

    takeDirty() {
        let out = {};
        for(let index of this.dirty) if(this.chunks[index]) out[index] = { index, data: this.chunks[index].data };
        this.dirty.clear();
        return out;
    }

    clear() {
        for(let key in this.chunks) if(this.chunks[key].manifold) this.chunks[key].manifold.delete();
        this.chunks = {};
        this.dirty.clear();
    }

    /** World-space triangle soup for a chunk's collider, or null if the chunk is implicit. */
    chunkPositions(index) {
        let c = this.chunks[index];
        return c ? decodeSoup(c.data) : null;
    }

    /**
     * Apply a brush boolean to a chunk. `msg` is the client's manifoldcsgoperation payload.
     * Returns an array of component bags for floating fragments (to become entities).
     */
    applyCsg(msg) {
        let index = msg.index;
        if(!this.chunks[index] || !this.chunks[index].manifold) {
            if(!msg.originalChunk) { console.error("csg op without originalChunk for fresh index " + index); return []; }
            this.chunks[index] = { index, data: msg.originalChunk, manifold: this.soupToManifold(msg.originalChunk) };
        }
        let chunk = this.chunks[index];
        let brush = this.soupToManifold(msg.brush,
            new THREE.Vector3(msg.brushPosition.x, msg.brushPosition.y, msg.brushPosition.z),
            new THREE.Quaternion(msg.brushQuaternion.x, msg.brushQuaternion.y, msg.brushQuaternion.z, msg.brushQuaternion.w),
            new THREE.Vector3(msg.brushScale.x, msg.brushScale.y, msg.brushScale.z));

        let op = parseInt(msg.operation);
        let result;
        if(op === ADDITION) result = chunk.manifold.add(brush);
        else if(op === INTERSECTION) result = chunk.manifold.intersect(brush);
        else if(op === SUBTRACTION) result = chunk.manifold.subtract(brush);
        else { console.error("Unknown manifold operation: " + op); brush.delete(); return []; }

        // Clip to the chunk's bounds
        let c = chunkCenter(index);
        let cube = this.manifold.Manifold.cube([CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE], true).translate(c.x, c.y, c.z);
        let clipped = result.intersect(cube);
        cube.delete(); result.delete(); chunk.manifold.delete(); brush.delete();

        let fragments = [];
        let islands = clipped.decompose();
        if(islands.length <= 1) {
            for(let i of islands) i.delete();
            chunk.manifold = clipped;
        } else {
            // Largest island is always terrain; smaller ones stay only if grounded.
            let info = islands.map((m, idx) => ({ idx, volume: m.volume() })).sort((a, b) => b.volume - a.volume);
            let terrain = [islands[info[0].idx]];
            for(let j = 1; j < info.length; j++) {
                let island = islands[info[j].idx];
                if(info[j].volume < 0.01) { island.delete(); continue; }
                if(this.isIslandGrounded(island, index)) terrain.push(island);
                else fragments.push(island);
            }
            let merged = terrain[0];
            for(let i = 1; i < terrain.length; i++) {
                let next = merged.add(terrain[i]);
                merged.delete(); terrain[i].delete();
                merged = next;
            }
            chunk.manifold = merged;
            clipped.delete();
            console.log(`Decomposed chunk ${index}: ${islands.length} islands, ${terrain.length} grounded, ${fragments.length} floating`);
        }

        chunk.data = this.manifoldToSoup(chunk.manifold);
        this.dirty.add(index);

        let out = [];
        for(let frag of fragments) { let comps = this.fragmentComponents(frag); frag.delete(); if(comps) out.push(comps); }
        return out;
    }

    /** An island is grounded if it touches a chunk face whose neighbour has terrain. */
    isIslandGrounded(island, index) {
        let { x, y, z } = chunkCoords(index);
        let verts = island.getMesh().vertProperties;
        let n = verts.length / 3;
        let eps = 0.15;
        let faces = [
            [0, x * 10 - 50, x - 1, y, z], [0, x * 10 - 40, x + 1, y, z],
            [1, y * 10 - 50, x, y - 1, z], [1, y * 10 - 40, x, y + 1, z],
            [2, z * 10 - 50, x, y, z - 1], [2, z * 10 - 40, x, y, z + 1],
        ];
        for(let [axis, boundary, nx, ny, nz] of faces) {
            if(nx < 0 || nx >= GRID || ny < 0 || ny >= GRID || nz < 0 || nz >= GRID) continue;
            if(!this.hasTerrain(nx * 100 + ny * 10 + nz)) continue;
            for(let i = 0; i < n; i++) if(Math.abs(verts[i * 3 + axis] - boundary) < eps) return true;
        }
        return false;
    }

    /** Components for a dynamic fragment body: Transform at the centroid, body-local mesh soup. */
    fragmentComponents(manifold) {
        let mesh = manifold.getMesh();
        let v = mesh.vertProperties, tri = mesh.triVerts;
        let numVerts = v.length / 3, numTris = tri.length / 3;
        if(numVerts < 4 || numTris < 1) return null;

        let cx = 0, cy = 0, cz = 0;
        for(let i = 0; i < numVerts; i++) { cx += v[i * 3]; cy += v[i * 3 + 1]; cz += v[i * 3 + 2]; }
        cx /= numVerts; cy /= numVerts; cz /= numVerts;

        let soup = new Float32Array(numTris * 9);
        let halfExtent = 0;
        for(let t = 0; t < numTris; t++) {
            for(let k = 0; k < 3; k++) {
                let i = tri[t * 3 + k];
                let lx = v[i * 3] - cx, ly = v[i * 3 + 1] - cy, lz = v[i * 3 + 2] - cz;
                soup[t * 9 + k * 3] = lx; soup[t * 9 + k * 3 + 1] = ly; soup[t * 9 + k * 3 + 2] = lz;
                halfExtent = Math.max(halfExtent, Math.abs(lx), Math.abs(ly), Math.abs(lz));
            }
        }
        return {
            Transform: Transform({ position: { x: cx, y: cy, z: cz } }),
            RigidBody: RigidBody({ shape: 'trimesh', halfExtent }),
            FragmentMesh: FragmentMesh({ data: encodeSoup(soup) }),
        };
    }

    // ---- codecs -----------------------------------------------------------

    soupToManifold(base64, position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3(1, 1, 1)) {
        let geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(decodeSoup(base64), 3));
        geometry = mergeVertices(geometry, 1e-4);
        let positions = geometry.attributes.position.array;
        let matrix = new THREE.Matrix4().compose(position, quaternion, scale);
        let vertProperties = new Float32Array(positions.length);
        let vertex = new THREE.Vector3();
        for(let i = 0; i < positions.length; i += 3) {
            vertex.set(positions[i], positions[i + 1], positions[i + 2]).applyMatrix4(matrix);
            vertProperties[i] = vertex.x; vertProperties[i + 1] = vertex.y; vertProperties[i + 2] = vertex.z;
        }
        let mesh = new this.manifold.Mesh({ numProp: 3, vertProperties, triVerts: new Uint32Array(geometry.index.array) });
        let out = new this.manifold.Manifold(mesh);
        out.simplify(0.1);
        return out;
    }

    manifoldToSoup(manifold) {
        let mesh = manifold.getMesh();
        let v = mesh.vertProperties, tri = mesh.triVerts;
        let soup = new Float32Array(tri.length * 3);
        for(let i = 0; i < tri.length; i++) {
            let vi = tri[i];
            soup[i * 3] = v[vi * 3]; soup[i * 3 + 1] = v[vi * 3 + 1]; soup[i * 3 + 2] = v[vi * 3 + 2];
        }
        return encodeSoup(soup);
    }
}
