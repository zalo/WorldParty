# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WorldParty is a multiplayer sandbox for building interactive worlds, similar to Garry's Mod. It uses three.js for 3D rendering and PartyKit for real-time multiplayer networking. Players can carve/add voxel terrain using CSG (Constructive Solid Geometry) operations and spawn 3D models (GLB files) by URL.

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Start PartyKit dev server with live reload (serves at localhost:1999)
npm run build        # Bundle client with esbuild to ./dist/
npm run deploy       # Deploy server + website to PartyKit cloud
```

Both `npm run dev` and `npm run deploy` serve the website via PartyKit (configured in `partykit.json` `serve` field). The client JS is bundled by PartyKit's built-in esbuild from `src/main.js` into `dist/`. `PARTYKIT_HOST` is injected as a global by the bundler.

## Architecture

### Client-Server Split

- **`src/server.js`** - PartyKit server (runs on Cloudflare Workers). Owns the authoritative ECS world, PhysX simulation, and terrain. Ticks at 30Hz, broadcasting `partialupdate` (dirty components only) and a `fullupdate` every 10s. Persists entities and chunks under per-key storage (`ent:<id>`, `chunk:<index>`) every 5s and on disconnect.
- **`src/main.js`** - Client entry point. Mirrors the server's entities into a local ECS world, runs render/interpolation systems, hosts the local `PlayerController`, terrain `BatchedMesh`, tools, and spawn menu. Connects via `PARTYKIT_HOST` (injected by bundler).

### Entity Component System

See `docs/ecs.md`. `src/ecs/World.js` is shared by both sides. Entities are id + plain-JSON components; names starting with `$` are transient runtime handles (PhysX actors, three.js meshes) that each host rebuilds. Server systems live in `src/server/Physics.js`, client systems in `src/client/systems.js`. Spawning, loading from storage, and (future) migrating between Durable Objects are all "create the entity, let systems materialize it".

### Key Modules

- **`src/World.js`** - Three.js WebGPU renderer, camera, lighting, SSGI + TRAA post-processing pipeline.
- **`src/PlayerController.js`** - First-person capsule player with BVH collision against terrain and ECS body meshes. WASD + PointerLock on desktop, nipplejs joysticks on mobile.
- **`src/terrain/grid.js`** - Chunk grid constants, neighbour lookup, and face-exposure mask shared by server and client.
- **`src/server/Terrain.js`** - Sparse chunk map with per-chunk Manifold booleans and fragment component extraction.
- **`src/server/Connectivity.js`** - Cross-chunk connectivity of solid (grounding, fragments) and air (which hollows are active and what to materialize).
- **`src/server/Physics.js`** - PhysX WASM setup, chunk colliders, and the ECS physics systems.
- **`src/props/PropRegistry.js`** - Single source of truth for spawnable props (collider shape, size, GLTF url, menu entry).
- **`src/tools/*`** - Garry's Mod style tools (physgun, CSG brush, rope, weld, hinge). Tools send messages; the server mutates entities.
- **`src/net/codec.js`** - geometry codecs shared by both sides (brush soups, versioned chunk meshes with per-triangle materials, binary chunk frames).
- **`src/terrain/materials.js`** - terrain material palette; ids are tracked through Manifold booleans via reserved original IDs (see `docs/ecs.md`).

### Terrain System

The world is a 10x10x10 grid of chunks, each a 10-unit cube, indexed `x*100 + y*10 + z`. Unmodified chunks are implicit (solid below y=5, empty above); only CSG-modified chunks are stored, as indexed meshes versioned by content hash. A `csg` message lists the overlapped chunk indices plus the brush soup and transform; the server runs the boolean in Manifold, clips to the chunk, and then lets connectivity decide what is unsupported; unsupported solid becomes `RigidBody{shape:'trimesh'} + FragmentMesh` entities with lazy-SDF colliders. Changed chunk bytes are pushed as binary WebSocket frames; updates otherwise carry only `{index: version}` and clients fetch missing versions over HTTP (`/parties/main/<room>/chunk/<index>?v=<version>`, served immutable). The client `TerrainMirror` keeps everything in one BatchedMesh that grows on demand. Grounding and loading are decided by `src/server/Connectivity.js`: solid and air islands per chunk, face footprints rasterized on a 16x16 grid, union-find across chunks. Unsupported solid becomes fragments (merged across chunks); terrain is only held and collided where it faces an air component containing a player or body, so buried rock and empty sealed caves cost nothing. Updates carry `chunks`/`rock`/`cull` maps and the client holds only what it is told to.

### Networking Protocol

JSON over WebSocket. Client → server: `player`, `csg`, `spawnprop`, `physgun_grab/move/release/freeze`, `createjoint`, `removejoint`, `deletebody`, `model`/`select`/`deselect`/`deletemodel`, `chat`, `reset`. Server → client: `fullupdate` / `partialupdate` with `entities`, `removed`, `chunks` (`{index: version|null}`), `rock` (`{index: faceMask}`), `cull` (`{index: faceMask}`), `serverTickMs`, plus binary chunk frames.

## Key Dependencies

- **three.js** - 3D rendering (bare specifier imports, resolved by esbuild bundler)
- **three-bvh-csg / three-mesh-bvh** - CSG operations and BVH-accelerated collision
- **manifold-3d** (vendored in `assets/manifold-3d/`) - WASM-based manifold CSG on server
- **partykit / partysocket** - Multiplayer server framework and client WebSocket wrapper
- **nipplejs** (vendored in `assets/nipplejs/`) - Mobile virtual joystick

## Notes

- Source uses bare specifier imports (e.g., `'three'`, `'three-mesh-bvh'`) resolved by esbuild during bundling.
- The server runs three.js headlessly for CSG computations (no rendering).
- Geometry data is serialized as gzip-compressed base64 (position arrays only), using fflate for compression.
- Server guards against double-disconnect (onClose/onError both call onDisconnect).
- Static assets (`index.html`, `assets/`) are served by PartyKit alongside the WebSocket server.
