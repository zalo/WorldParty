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
server, `src/client/TerrainMirror.js` on the client), keyed `"x,y,z"` over
an unbounded grid. A world config (`terrain/grid.js`) gives the room's
bounds and the box of implicit rock; unstored chunks inside it are rock,
unstored chunks elsewhere are air. The config is persisted per room and
sent with full updates, so an imported world simply ships a different one.
They are spatial structure rather than things with identity, and they
replicate differently:

- Each stored chunk is an indexed mesh encoded by `encodeChunkMesh()` and
  versioned by a content hash. Explicitly empty chunks have version `0`.
- Update messages carry only `{index: version}`. Clients compare with their
  local version and `GET /parties/main/<room>/chunk/<x,y,z>?v=<version>`;
  a URL naming the current version is served `immutable`, so browsers and
  edge caches keep it.
- Right after an edit the server also pushes the new bytes to everyone in
  the room as a binary WebSocket frame (`packChunkFrame`), so the editor and
  nearby players see the change without a round trip.
- The client never sends chunk geometry. A `csg` message lists the chunk
  indices the brush overlaps plus the brush soup and transform; the server
  materializes implicit chunks itself.
- Storage key `chunk:<x,y,z>` holds `{key, version, bytes}`. Rooms saved
  in the old base64 soup format are migrated on load.

### Connectivity: grounding and hollows

`src/server/Connectivity.js` answers two questions after every edit, with one
primitive. Each stored chunk is summarized into solid islands (Manifold
`decompose`) and air islands (the chunk cube minus the solid, decomposed).
Every island's contact with the six chunk faces is rasterized onto a 16x16
grid (0.625 m cells) from the triangles lying flat on that face. Islands in
neighbouring chunks are joined with a union-find when their footprints on
the shared face overlap a cell. Untouched rock is one solid island with full
faces; explicitly empty chunks are one air island with full faces, and
unstored air is the sky itself. The solve iterates the stored chunks plus
the implicit rock box, so its cost follows the edited world, not the bounds. The underside of the grid is `GROUND`; the sides and top are `SKY`.

- **Grounding.** Any solid component not connected to `GROUND` is floating.
  Its islands are merged across chunks (`Manifold.union`) into one fragment
  entity and removed from their chunks; a rock chunk that is fully undercut
  becomes a fragment too. Components below `DUST_VOLUME` just vanish, and
  components above `MAX_FRAGMENT_VOLUME` (1.5 chunks) are kept as terrain
  with a log line, since dropping a mountain is never what anyone wanted.
  Removing solid can merge hollows, so the solve repeats until nothing
  floats. The old per-chunk rule ("largest island stays, smaller islands
  stay if any face neighbour has terrain") is gone.
- **Hollows.** An air component is active when a player or a body stands in
  a chunk it touches (all air islands of that chunk, conservatively; falling
  out of the grid counts as sky). `Connectivity.states()` then says what each
  chunk should materialize: rock contributes the faces that touch active air
  (`{mask}`), a modified chunk is held when it touches active air and culls
  the boundary faces that do not (`{active, cull}`), everything else is
  nothing. A sealed cave nobody is in costs nothing on either side; a player
  sealed inside a cave unloads the surface for that server's clients.

Rasterized contact is conservative both ways: solid sharing a cell with
solid counts as attached, air sharing a cell with air counts as connected.
Both errors are safe (terrain stays put, a little extra gets loaded).

The server tracks which chunks contain players or bodies each tick and
re-derives states only when that set changes or after an edit. The states
are diffed against what was last sent and the delta rides on the next
`partialupdate` as `chunks` `{key: version|null}`, `rock` `{key: mask}`
and `cull` `{key: mask}`; full updates carry the whole maps. Chunk
colliders follow the same states (box for rock faces, triangle mesh for held
chunks). The client `TerrainMirror` holds only what it is told to and
rebuilds a chunk when its mesh or mask changes. The player controller holds
still while a chunk near it is still being fetched, so a teleport into a
freshly activated hollow does not fall through a floor that has not arrived.
`TerrainMirror.stats()` reports what is loaded.

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
