# Entity model

WorldParty's dynamic state (players, props, terrain fragments, joints,
legacy URL models) lives in a small Entity Component System shared by the
PartyKit server and the browser client: `src/ecs/World.js`.

## Entities are documents

An entity is an id plus a bag of plain-JSON components. The same shape is
used everywhere:

| Use | Call |
|---|---|
| Replication (partial update) | `world.takeDirty()` → `{ entities: {id: {Comp: data \| null}}, removed: [ids] }` |
| Replication (full update) | `world.serialize()` |
| Durable storage | `world.serializeEntity(id, filter)` per entity under `ent:<id>` |
| Applying any of the above | `world.applySnapshot(entities, { full, removed })` |

Because a serialized entity is self-contained, moving one to another host
Durable Object is the same operation as loading it from storage: create the
entity with its persistent components and let that host's systems
materialize the rest.

## Persistent vs transient components

Component names starting with `$` are **transient**: runtime handles that
are never serialized, replicated, or persisted. Each host rebuilds them from
the persistent components.

| Persistent | Server transient | Client transient |
|---|---|---|
| `Transform` | | `$Snapshot` (interpolation) |
| `RigidBody` | `$PxBody` (PhysX actor) | `$Mesh` (three.js object + BVH) |
| `Prop`, `FragmentMesh` | | `$Mesh` |
| `Joint` | `$PxJoint` | `$Line` |
| `Grabbed` | `$Grab` (anchor + D6 drive), `$GrabTarget` | |
| `Player` | `$PxKinematic` (capsule) | `$Mesh`, `$Label` |
| `Model` | | `$Mesh` |

Shapes and defaults are in `src/ecs/components.js`. `PERSISTED` lists the
components written to storage; player entities are never persisted.

## Systems

Systems are plain objects with `update(world, dt)` and an optional
`init(world)`. They run in registration order each tick.

**Server** (`src/server/Physics.js`): `playerSystem` (kinematic capsules
with velocity projection), `bodySystem` (materialize actors for `RigidBody`
entities), `jointSystem`, `grabSystem`, then `stepSystem` (simulate and
write poses back into `Transform`; bodies are marked dirty at 15Hz while
awake, once more when they fall asleep). Removing a transient component
releases its PhysX object via the world's `remove` event, so `destroy()`
cleans up in one place.

**Client** (`src/client/systems.js`): `SceneCleanupSystem`,
`BodyRenderSystem` (placeholder box, then GLTF swap-in, merged BVH for
player collision), `ModelRenderSystem`, `SnapshotSystem`,
`PlayerRenderSystem`, `JointRenderSystem`.

## Change tracking

`add` / `set` / `touch` / `remove` on a persistent component mark it dirty
for that entity. The server tick broadcasts `takeDirty()` as a
`partialupdate` whenever anything changed and a `fullupdate` every 300
ticks. The same `set` events feed the persistence queue, flushed every 5s
and on disconnect, in batches of 128 keys (the Durable Object limit).

## Not entities (yet)

Terrain chunks stay a separate sparse map (`src/server/Terrain.js` on the
server, `src/client/TerrainMirror.js` on the client), keyed by chunk index.
They are spatial structure rather than things with identity, and they
replicate differently:

- Each stored chunk is an indexed mesh encoded by `encodeChunkMesh()` and
  versioned by a content hash. Explicitly empty chunks have version `0`.
- Update messages carry only `{index: version}`. Clients compare with their
  local version and `GET /parties/main/<room>/chunk/<index>?v=<version>`;
  a URL naming the current version is served `immutable`, so browsers and
  edge caches keep it.
- Right after an edit the server also pushes the new bytes to everyone in
  the room as a binary WebSocket frame (`packChunkFrame`), so the editor and
  nearby players see the change without a round trip.
- The client never sends chunk geometry. A `csg` message lists the chunk
  indices the brush overlaps plus the brush soup and transform; the server
  materializes implicit chunks itself.
- Storage key `chunk:<index>` holds `{index, version, bytes}`. Rooms saved
  in the old base64 soup format are migrated on load.

### Only what can be seen is materialized

`src/terrain/grid.js` is shared by both sides and answers, for any chunk,
which of its six faces border something other than unmodified solid rock
(`exposedFaces`). Beyond the grid, the underside counts as solid (players
and bodies are reset at y=-100, so nothing can get there) and the sides and
top count as air.

- Unmodified rock chunks with no exposed face are fully buried. The client
  gives them no geometry and the server gives them no collider. In a fresh
  world 256 of the 500 solid chunks are buried.
- Exposed rock contributes only its exposed faces, two triangles each,
  instead of a full box: the untouched world renders 600 triangles rather
  than 6000 and keeps 244 small BVHs rather than 500.
- Modified chunks keep their decoded mesh client-side and drop the boundary
  triangles that lie flat against rock, so a carved chunk's underside and
  the sides facing untouched neighbours are never drawn. The stored manifold
  is untouched by this; culling is a render-time view.
- When a chunk changes state, its six neighbours are re-evaluated and
  rebuilt only if their exposure mask changed. Carving into rock exposes the
  rock behind it on both sides: the client grows faces, the server adds box
  colliders (`ensureDefaultCollider`). Exposure only ever grows until a
  `reset`.

`TerrainMirror.stats()` reports loaded chunks, drawn triangles, rock and
buried counts for diagnostics.

## Terrain materials

Every triangle carries a material id (`src/terrain/materials.js`). The
server reserves one Manifold original ID per material at startup and tags
each brush and each implicit chunk cube with its material's ID
(`Terrain.withMaterial`). Manifold booleans report, per run of output
triangles, which original they came from, so after a subtract the cut
faces carry the brush's material while untouched faces keep theirs.
`Terrain.triangleMaterials` reads the runs back; `meshToManifold` rebuilds
runs from stored per-triangle ids so provenance survives restarts. Chunk
bytes append one byte per triangle; the client expands chunks to flat
triangles with a vertex color per face, and fragments carry `mats` in
their `FragmentMesh` component. The CSG tool cycles materials with `R`
(or the Material button on mobile).
