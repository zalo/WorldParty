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
