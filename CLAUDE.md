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

- **`src/server.js`** - PartyKit server (runs on Cloudflare Workers). Manages authoritative game state: players, chunks (voxel terrain), and models. Broadcasts updates at 30Hz with partial/full update distinction. Persists chunks and models to PartyKit durable storage on disconnect. Non-serializable WASM manifold objects are stripped before storage via `getSerializableChunks()`.
- **`src/main.js`** - Client entry point. `Main` class handles the game loop, CSG brush placement, model spawning, and WebSocket communication via PartySocket. Connects via `PARTYKIT_HOST` (injected by bundler).

### Key Modules

- **`src/World.js`** - Three.js scene setup: renderer, camera, lighting, post-processing pipeline (EffectComposer with SSILVB ambient occlusion pass).
- **`src/PlayerController.js`** - First-person player with capsule-vs-BVH collision. Features coyote time for jumping, walk animation bounce, camera-relative movement. WASD + PointerLock on desktop, dual nipplejs joysticks on mobile.
- **`src/SSILVBPass.js` / `src/SSILVBShader.js`** - Custom screen-space indirect lighting post-processing effect.

### Terrain System

The world is a 10x10x10 grid of chunks (1000 total). Each chunk is a `Brush` from three-bvh-csg. Terrain modifications use CSG operations:
- **Client** sends the brush geometry (gzip + base64 encoded) and transform to the server
- **Server** performs CSG via Manifold (WASM, in `assets/manifold-3d/`) for robust boolean operations, then broadcasts the result
- Chunks are indexed as `x*100 + y*10 + z`, each covering a 10-unit cube

### Model System

Models are spawned by providing a GLB URL. The server stores model state (position, quaternion, scale, selectedBy) and broadcasts to all clients. Models are loaded client-side via GLTFLoader with meshopt decoder. Players can select/deselect models and move them with the CSG brush.

### Networking Protocol

Messages are JSON over WebSocket. Key message types: `player` (position), `model` (create/update), `select`/`deselect` (model interaction), `deletemodel`, `manifoldcsgoperation` (terrain edit), `reset`, `chat`. Server sends `fullupdate` every 10 seconds and `partialupdate` at 30Hz for changed entities.

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
