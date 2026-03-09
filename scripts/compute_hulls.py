"""Download Draco-compressed prop GLTFs, decode, run CoACD convex decomposition.
Outputs JSON files with arrays of convex hull vertex arrays."""

import json, os, urllib.request, base64, struct
import numpy as np
import coacd

try:
    import DracoPy
except ImportError:
    print("pip install DracoPy")
    exit(1)

from pygltflib import GLTF2

PROPS = {
    "barrel":  "https://raw.githubusercontent.com/pmndrs/market-assets/main/files/models/barrel/model.gltf",
    "crate":   "https://raw.githubusercontent.com/pmndrs/market-assets/main/files/models/sci-fi-crate/model.gltf",
    "chest":   "https://raw.githubusercontent.com/pmndrs/market-assets/main/files/models/chest/model.gltf",
    "bench":   "https://raw.githubusercontent.com/pmndrs/market-assets/main/files/models/bench/model.gltf",
    "ball":    "https://raw.githubusercontent.com/pmndrs/market-assets/main/files/models/cannon-ball/model.gltf",
    "can":     "https://raw.githubusercontent.com/pmndrs/market-assets/main/files/models/soda-can/model.gltf",
    "pot":     "https://raw.githubusercontent.com/pmndrs/market-assets/main/files/models/pot/model.gltf",
    "tower":   "https://raw.githubusercontent.com/pmndrs/market-assets/main/files/models/tower/model.gltf",
    "board":   "https://raw.githubusercontent.com/pmndrs/market-assets/main/files/models/cutting-board/model.gltf",
    "sword":   "https://raw.githubusercontent.com/pmndrs/market-assets/main/files/models/sword/model.gltf",
}

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "assets", "props", "hulls")
CACHE_DIR = "/tmp/worldparty_props"
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(CACHE_DIR, exist_ok=True)


def extract_draco_meshes(gltf_path):
    """Extract vertex positions from a Draco-compressed GLTF file."""
    gltf = GLTF2.load(gltf_path)

    # Decode embedded buffer
    buf_uri = gltf.buffers[0].uri
    if buf_uri.startswith("data:"):
        buf_data = base64.b64decode(buf_uri.split(",")[1])
    else:
        buf_dir = os.path.dirname(gltf_path)
        with open(os.path.join(buf_dir, buf_uri), "rb") as f:
            buf_data = f.read()

    all_verts = []
    all_faces = []
    vert_offset = 0

    for mesh in gltf.meshes:
        for prim in mesh.primitives:
            ext = prim.extensions or {}
            draco = ext.get("KHR_draco_mesh_compression")
            if draco:
                bv_idx = draco["bufferView"]
                bv = gltf.bufferViews[bv_idx]
                draco_bytes = buf_data[bv.byteOffset:bv.byteOffset + bv.byteLength]
                decoded = DracoPy.decode(draco_bytes)
                points = np.array(decoded.points).reshape(-1, 3)
                faces = np.array(decoded.faces).reshape(-1, 3)
                all_verts.append(points)
                all_faces.append(faces + vert_offset)
                vert_offset += len(points)
            else:
                # Non-Draco: read raw position data
                pos_idx = prim.attributes.POSITION
                if pos_idx is None:
                    continue
                acc = gltf.accessors[pos_idx]
                bv = gltf.bufferViews[acc.bufferView]
                start = bv.byteOffset + (acc.byteOffset or 0)
                stride = bv.byteStride or 12
                points = []
                for i in range(acc.count):
                    offset = start + i * stride
                    x, y, z = struct.unpack_from("<fff", buf_data, offset)
                    points.append([x, y, z])
                points = np.array(points)

                # Read indices
                idx_acc = gltf.accessors[prim.indices]
                idx_bv = gltf.bufferViews[idx_acc.bufferView]
                idx_start = idx_bv.byteOffset + (idx_acc.byteOffset or 0)
                if idx_acc.componentType == 5123:  # UNSIGNED_SHORT
                    fmt, sz = "<H", 2
                else:  # UNSIGNED_INT
                    fmt, sz = "<I", 4
                indices = []
                for i in range(idx_acc.count):
                    val = struct.unpack_from(fmt, buf_data, idx_start + i * sz)[0]
                    indices.append(val)
                faces = np.array(indices).reshape(-1, 3)

                all_verts.append(points)
                all_faces.append(faces + vert_offset)
                vert_offset += len(points)

    if not all_verts:
        return None, None
    return np.vstack(all_verts), np.vstack(all_faces)


for prop_id, url in PROPS.items():
    print(f"\n=== {prop_id} ===")

    local_path = os.path.join(CACHE_DIR, f"{prop_id}.gltf")
    if not os.path.exists(local_path):
        print(f"  Downloading {url}")
        urllib.request.urlretrieve(url, local_path)

    print(f"  Extracting Draco meshes...")
    verts, faces = extract_draco_meshes(local_path)
    if verts is None:
        print(f"  WARNING: No meshes found, skipping")
        continue

    print(f"  Mesh: {len(verts)} verts, {len(faces)} faces")
    print(f"  Bounds: {verts.min(axis=0)} to {verts.max(axis=0)}")

    # Normalize to unit size (centered, max extent = 1)
    center = (verts.min(axis=0) + verts.max(axis=0)) / 2
    extent = (verts.max(axis=0) - verts.min(axis=0)).max()
    if extent < 1e-6:
        print(f"  WARNING: Degenerate mesh, skipping")
        continue
    verts_norm = (verts - center) / extent

    # Run CoACD
    print(f"  Running CoACD...")
    faces_i32 = faces.astype(np.int32)
    verts_f64 = verts_norm.astype(np.float64)

    try:
        mesh_coacd = coacd.Mesh(verts_f64, faces_i32)
        parts = coacd.run_coacd(mesh_coacd, threshold=0.08, max_convex_hull=16)
        total_verts = sum(len(v) for v, f in parts)
        if total_verts == 0:
            raise ValueError("Empty hulls")
        print(f"  CoACD: {len(parts)} convex parts")
    except Exception as e:
        print(f"  CoACD failed ({e}), using convex hull fallback")
        import trimesh
        tm = trimesh.Trimesh(vertices=verts_norm, faces=faces_i32)
        hull = tm.convex_hull
        parts = [(hull.vertices.astype(np.float64), hull.faces.astype(np.int32))]

    hulls = []
    for part_verts, part_faces in parts:
        hull_verts = np.round(part_verts, 4).tolist()
        if hull_verts:
            hulls.append({"vertices": hull_verts})
            print(f"    Part: {len(hull_verts)} vertices")

    out_path = os.path.join(OUT_DIR, f"{prop_id}.json")
    with open(out_path, "w") as f:
        json.dump({"propId": prop_id, "hulls": hulls}, f, separators=(",", ":"))

    print(f"  Saved {out_path} ({os.path.getsize(out_path)} bytes)")

print("\nDone!")
