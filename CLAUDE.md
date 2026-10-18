# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WorldParty is a multiplayer sandbox for building interactive worlds, similar to Garry's Mod. It uses three.js for 3D rendering and PartyKit for real-time multiplayer networking. Players can carve/add voxel terrain using CSG (Constructive Solid Geometry) operations and spawn 3D models (GLB files) by URL.

## Commands

```bash
npm install          # Install dependencies
npm run dev          # wrangler dev + esbuild watch (tools/dev.mjs); serves the site and rooms at localhost:1999 (PORT=... to change)
npm run build        # Assemble the static site in ./public/ (index.html, assets/, bundled dist/main.js) via tools/build-site.mjs
npm run deploy       # Build, then `wrangler deploy` the Worker, Durable Object and site to Cloudflare (https://worldparty.makeshifted.workers.dev)
node tools/import-world.mjs model.glb --name castle --size 60   # GLB -> destructible world manifest in assets/worlds/
node tools/profile/build.mjs && node tools/profile/csg.mjs assets/worlds/castle-exact.json [chunkKey] [carves]   # time a carve stage by stage against the real server class in Node (also summary.mjs, cook.mjs) (also tick.mjs: where a tick's time goes; replay.mjs: carves recorded from a client)
```

Open `?room=<name>&import=/assets/worlds/castle.json` (or call `main.importWorld(url)`) to upload a manifest into a room; the room's terrain, entities and world config are replaced.

Hosting is a Cloudflare Worker (`wrangler.jsonc`): the room server is a Durable Object class bound as `Main` and routed by [PartyServer](https://github.com/threepointone/partyserver)'s `routePartykitRequest` (so clients still use `/parties/main/<room>`), and everything else is served from `public/` as static assets (SPA fallback). The client JS is bundled by esbuild from `src/main.js` into `public/dist/`; `PARTYKIT_HOST` is injected as a global and is only the fallback host for pages not served over http(s). Rooms persist in SQLite-backed Durable Object storage (2 MiB per value; chunk bytes are still split into parts). The hosted PartyKit platform shut down in October 2026; `partykit.json` is gone.

## Architecture

### Client-Server Split

- **`src/server.js`** - Room server: a PartyServer `Server` (Durable Object) plus the Worker `fetch` export. Owns the authoritative ECS world, PhysX simulation, and terrain. Ticks at 30Hz, broadcasting `partialupdate` (dirty components only) and a `fullupdate` every 10s (without `FragmentMesh`, which never changes after creation; the one sent on connect has everything). Persists entities and chunks under per-key storage (`ent:<id>`, `chunk:<x,y,z>`; legacy numeric chunk keys are migrated on load) every 5s and on disconnect.
- **`src/main.js`** - Client entry point. Mirrors the server's entities into a local ECS world, runs render/interpolation systems, hosts the local `PlayerController`, the terrain mirror, tools, and spawn menu. Connects via `PARTYKIT_HOST` (injected by bundler).

### Entity Component System

See `docs/ecs.md`. `src/ecs/World.js` is shared by both sides. Entities are id + plain-JSON components; names starting with `$` are transient runtime handles (PhysX actors, three.js meshes) that each host rebuilds. Server systems live in `src/server/Physics.js`, client systems in `src/client/systems.js`. Spawning, loading from storage, and (future) migrating between Durable Objects are all "create the entity, let systems materialize it".

### Key Modules

- **`src/World.js`** - Three.js WebGPU renderer, camera, sun light, SSGI + TRAA post-processing pipeline (ACES tone mapping, exposure 0.55), and the sky setup.
- **`src/client/ProbeLighting.js`** - Irradiance probe grid (three `LightProbeGrid`, WebGPU only) over the world bounds, baked on the GPU a few probes per frame; `TerrainMirror.onChunkChanged` marks the probes around a changed chunk dirty so destruction rebakes only locally. `?probes=0` disables it. With probes on, `scene.environmentIntensity` is lowered to 0.3 so the sky's diffuse light is not counted twice.
- **`src/sky/`** - Physically based sky ported from tidewater's three.js/TSL version (commit `3dd589b` there): `Atmosphere` (Hillaire LUTs in compute, sun transmittance / sky irradiance readback), `Sky` (sun disk, stars, moon; no clouds yet), `Environment` (progressive cube capture + PMREM into `scene.environment`), `DayCycle` (time of day, sun direction, key light colour; `?time=<hours>`, `?daylength=<minutes>`). Needs the WebGPU backend; otherwise `World` falls back to the static skybox image and a hemisphere light.
- **`src/PlayerController.js`** - First-person capsule player with BVH collision against terrain and ECS body meshes. WASD + PointerLock on desktop, nipplejs joysticks on mobile.
- **`src/terrain/grid.js`** - Sparse chunk grid shared by server and client: keys, world config (bounds + implicit rock box), neighbour lookup, box queries.
- **`src/server/Terrain.js`** - Sparse chunk map with per-chunk Manifold booleans and fragment component extraction. Chunk bytes are the source of truth; the most recently used chunks keep a Manifold object and their decoded mesh up to a triangle budget (`RESIDENT_TRIS`, 250k: the whole castle fits), the rest are rebuilt by `manifoldOf()` on demand (`prepare()` gunzips them natively before a carve).
- **`src/server/Connectivity.js`** - Cross-chunk connectivity of solid (grounding, fragments) and air (which hollows are active and what to materialize).
- **`src/server/Physics.js`** - PhysX WASM setup, chunk colliders, and the ECS physics systems. The vendored `physx-js-webidl.wasm` has its initial memory patched from 64 MB to 16 MB (`tools/patch-wasm-memory.mjs`; it grows on demand).
- **`src/props/PropRegistry.js`** - Single source of truth for spawnable props (collider shape, size, GLTF url, menu entry).
- **`src/tools/*`** - Garry's Mod style tools (physgun, CSG brush, rope, weld, hinge). Tools send messages; the server mutates entities.
- **`src/net/codec.js`** - geometry codecs shared by both sides (brush soups, versioned chunk meshes with per-triangle materials, binary chunk frames).
- **`src/terrain/materials.js`** - terrain material palette; ids are tracked through Manifold booleans via reserved original IDs (see `docs/ecs.md`).

### Units and gravity

World units are metres (10 m chunks, 1 m props, a 2 m player capsule) but nothing falls at 1 g (`src/gravity.js`): real gravity at this scale reads as slow motion, so the player controller is tuned at `PLAYER_GRAVITY` (8 g) and rigid bodies fall at `DEFAULT_BODY_GRAVITY` (60 m/s², chosen by feel on the castle; a metre-sized block at the player's 8 g looks like a toy). Under that gravity a falling body covers over 2 m per 30 Hz step, so every dynamic body has speculative CCD (without it a cannonball dropped from the walls goes straight through the ground), the shared material's restitution is 0.05 so things land dead, and sleep thresholds scale with gravity (`PxTolerancesScale.speed`, `fragmentSleepThreshold`), otherwise contact jitter keeps whole piles awake. A room overrides the body gravity with `world.gravity` (set from the client with `?gravity=<m/s²>` → `setgravity`, persisted with the world config, replaced by an import, reported in chat); `Physics.setGravity` wakes every body so piles re-settle.

### Terrain System

The world is a sparse grid of 10-unit chunks keyed `"x,y,z"` (chunk x covers [10x, 10x+10)). A per-room world config (`src/terrain/grid.js` `DEFAULT_WORLD`, stored under the `world` key, sent in full updates) gives the bounds and the box of implicit rock; the sandbox default is a 100 m cube centred on the origin, solid below y=0. Unstored chunks are implicit (rock inside that box, air elsewhere); only CSG-modified chunks are stored, as indexed meshes versioned by content hash. A `csg` message lists the overlapped chunk keys plus the brush soup and transform; the server runs the boolean in Manifold (clipping to the chunk only for additions), re-encodes the chunk (uncompressed layout, whose FNV hash is the version; the gzip runs later with the platform's native `CompressionStream`, `Terrain.compress()`, never on the carve path) and pushes it to every holder as a binary WebSocket frame right away: a delta against the version they hold (`encodeChunkDelta`, typically a few KB: old vertices and triangles by reference, new ones inline, exact reconstruction so deltas chain) or the full bytes when the change is large or the holder's version is unknown. Grounding, fragment shedding, colliders and activity run in a timer callback once the frames are out (`settleNow`), so carving latency is the boolean plus the encode. Unsupported solid becomes `RigidBody{shape:'trimesh'} + FragmentMesh` entities; their collider is a compound of convex hulls (`FragmentMesh.hulls`, built by `Terrain.fragmentHulls` from ~1.5 m cells of the fragment, at most 24) because a dynamic SDF triangle mesh costs 1 to 3 ms of PhysX per awake fragment per tick (a woken pile of rubble used to saturate the 33 ms tick and every carve queued behind it). Fragments stored without hulls get them on load (`upgradeFragments`); the SDF mesh remains the fallback when no hull cooks. Updates otherwise carry only `{key: version}` and clients fetch missing versions over HTTP (`/parties/main/<room>/chunk/<x,y,z>?v=<version>`, served immutable and cached at the edge by the Worker). The client `TerrainMirror` keeps one `Mesh` (with its own BVH) per held chunk under a group. Grounding and loading are decided by `src/server/Connectivity.js`: solid and air islands per chunk, face footprints rasterized on a 16x16 grid, union-find across chunks. Per-chunk summaries are persisted (`summary:<key>`, adopted when the version matches) so a room starts without rebuilding any manifold; mesh colliders are cooked nearest to players and awake bodies first, a few per tick. Unsupported solid becomes fragments (merged across chunks); terrain is only held and collided where it faces an air component containing a player or an awake body (sleeping bodies keep nothing loaded; removing or restoring a collider does not wake what rests on it, only a geometry change wakes the bodies reaching into that chunk, `Physics.wakeNear`), so buried rock and empty sealed caves cost nothing. Updates carry `chunks`/`rock`/`cull` maps and the client holds only what it is told to.

### World Import

`tools/import-world.mjs` turns any GLB into terrain without assuming watertight or consistently oriented input, following the order 3D-printing slicers repair meshes in. The default `--mode exact` works per GLB primitive and per edge-connected component (`tools/lib/repair.mjs`): weld vertices within `--weld`, drop degenerate and duplicate triangles, orient faces consistently and outward, fill boundary loops shorter than `--hole`, thicken anything still open into a shell of `--shell` metres (retrying thinner), reject results that cross themselves, and flip inside-out solids. Closed components keep every triangle, UV and material; `Manifold.union` resolves the components against each other, like Cura's union of overlapping volumes. Components that cannot be closed (non-manifold edges, self-crossing shells) fall back to a level set of their own with UVs projected from their triangles. `--mode shell|winding|both|parity` instead level-sets the whole soup (shell: solid within `--shell` of any surface; winding: generalized winding number). The result is simplified, split by exact chunk-cube intersection, and written as `{world, chunks: {key: {version, bytes}}}` with the source materials (exact base colours, base colour textures written next to the manifest). With the default floor, an exact ground slab sits under the model on implicit rock. The client uploads manifests in `import_begin` / `import_chunks` / `import_end` messages.

### Networking Protocol

JSON over WebSocket. Client → server: `player`, `csg`, `import_begin/chunks/end`, `spawnprop`, `physgun_grab/move/release/freeze`, `createjoint`, `removejoint`, `deletebody`, `model`/`select`/`deselect`/`deletemodel`, `chat`, `reset`, `setgravity`. Server → client: `fullupdate` / `partialupdate` with `entities`, `removed`, `chunks` (`{key: version|null}`), `rock` (`{key: faceMask}`), `cull` (`{key: faceMask}`), `serverTickMs`, plus binary chunk frames (type 1 full, type 2 delta with a base version). Note `Date.now()` does not advance during synchronous work on Cloudflare, so server-side ms figures are only meaningful in the Node harness.

## Key Dependencies

- **three.js** - 3D rendering (bare specifier imports, resolved by esbuild bundler)
- **three-bvh-csg / three-mesh-bvh** - CSG operations and BVH-accelerated collision
- **manifold-3d** (3.5.4, vendored in `assets/manifold-3d/` with one patch so the Workers bundler never sees a `node:` import; 3.2.0 faulted on chunks above ~15k triangles) - WASM-based manifold CSG on server and in the importer
- **partyserver / partysocket / wrangler** - Durable Object room framework, client WebSocket wrapper, and the Cloudflare CLI used for dev and deploy
- **nipplejs** (vendored in `assets/nipplejs/`) - Mobile virtual joystick

## Memory budget

A Durable Object gets 128 MB. Measure with `node tools/profile/build.mjs && node --expose-gc tools/profile/mem.mjs` / `heap.mjs` / `heap-steps.mjs`; the `World ready` log line prints both WASM heap sizes. Emscripten heaps never shrink, so peaks matter: the castle (73 chunks, 196k triangles) starts warm at 16 MB Manifold, grows to about 33 MB as chunks are carved and stay resident (`RESIDENT_TRIS`), and peaks at 33 MB on a cold settle of the whole world (import or no stored summaries), which runs under the smaller `COLD_RESIDENT_TRIS` budget; PhysX 16 MB, JS about 35 MB. Keep this in mind for anything that holds manifolds for many chunks at once (the settle loop releases each chunk's islands as soon as its last fragment is built for exactly this reason). `WARM=1 node tools/profile/replay.mjs ...` measures the production path (second start adopting stored summaries).

## Notes

- Source uses bare specifier imports (e.g., `'three'`, `'three-mesh-bvh'`) resolved by esbuild during bundling.
- The server runs three.js headlessly for CSG computations (no rendering).
- Geometry data is serialized as gzip-compressed base64 (position arrays only), using fflate for compression.
- Server guards against double-disconnect (onClose/onError both call onDisconnect).
- Static assets (`index.html`, `assets/`, the bundle) are copied into `public/` by the build and served by Workers Assets; the Worker only sees `/parties/*`.
