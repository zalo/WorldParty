/** Blast craters shaped like broken rock instead of a sphere: the union of the Voronoi cells of seeds scattered inside
 *  the blast, taken against seeds scattered just outside it. Every face of the crater is a flat piece of the plane
 *  halfway between an inside and an outside seed, so it is bounded by facets meeting at angles, the way stone breaks
 *  along planes; jittered seeds make every crater different.
 *
 *  `reachAt(dir)` is how far the blast gets along a direction (hardness shortens it: Terrain.solidProbe), and the
 *  seeds are placed along each direction in proportion to it, so a crater against a castle wall is a shallow dish in
 *  the wall and a full bowl in the dirt in front of it. Pure geometry: the caller hulls the cells into a manifold.
 *
 *  Inside seeds lie at 0.3-0.6 of the reach, outside ones at 1.12-1.55 of it, so the faces between them fall near the
 *  reach itself. The cells of two inside seeds share a face; each is grown past it by EPS so they overlap and their
 *  union is clean (touching faces are a degenerate case for a boolean). That changes nothing about the union: a point
 *  in the overlap is nearer to the neighbouring inside seed than to any outside one, so it was inside already. */
const N_IN = 14, N_OUT = 38;

/** `n` directions spread evenly over the sphere (a Fibonacci lattice), turned by a random rotation. */
function directions(n, rng) {
    let q = randomRotation(rng), out = [];
    let golden = Math.PI * (3 - Math.sqrt(5));
    for(let i = 0; i < n; i++) {
        let y = 1 - (2 * i + 1) / n, r = Math.sqrt(1 - y * y), a = i * golden;
        out.push(rotate(q, [Math.cos(a) * r, y, Math.sin(a) * r]));
    }
    return out;
}
function randomRotation(rng) { // a uniformly random unit quaternion (Shoemake)
    let u1 = rng(), u2 = rng() * 2 * Math.PI, u3 = rng() * 2 * Math.PI;
    let a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
    return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
}
function rotate(q, v) {
    let [x, y, z, w] = q, [vx, vy, vz] = v;
    let ix = w * vx + y * vz - z * vy, iy = w * vy + z * vx - x * vz, iz = w * vz + x * vy - y * vx, iw = -x * vx - y * vy - z * vz;
    return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}
/** Nudge a direction by up to `amount` (radians, roughly) and renormalise. */
function jitter(d, amount, rng) {
    let v = [d[0] + (rng() - 0.5) * 2 * amount, d[1] + (rng() - 0.5) * 2 * amount, d[2] + (rng() - 0.5) * 2 * amount];
    let l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
}

/** A convex polyhedron as faces, each `{ p, n, gen }`: a loop of vertices, its outward normal and the plane it lies on
 *  (the seed whose bisector it is, or -1..-6 for the bounding cube). A vertex is `{ x: [x, y, z], planes: [a, b, c] }`:
 *  the three planes through it, which name it across cells (see the boundary below). The cube of half size h at c: */
function cube(c, h) {
    let v = (sx, sy, sz) => ({ x: [c[0] + sx * h, c[1] + sy * h, c[2] + sz * h], planes: [sx < 0 ? -1 : -2, sy < 0 ? -3 : -4, sz < 0 ? -5 : -6] });
    let V = {};
    for(let sx of [-1, 1]) for(let sy of [-1, 1]) for(let sz of [-1, 1]) V[`${sx}${sy}${sz}`] = v(sx, sy, sz);
    let f = (gen, n, keys) => ({ gen, n, p: keys.map(k => V[k]) });
    return [
        f(-1, [-1, 0, 0], ['-1-1-1', '-1-11', '-111', '-11-1']), f(-2, [1, 0, 0], ['1-1-1', '11-1', '111', '1-11']),
        f(-3, [0, -1, 0], ['-1-1-1', '1-1-1', '1-11', '-1-11']), f(-4, [0, 1, 0], ['-11-1', '-111', '111', '11-1']),
        f(-5, [0, 0, -1], ['-1-1-1', '-11-1', '11-1', '1-1-1']), f(-6, [0, 0, 1], ['-1-11', '1-11', '111', '-111']),
    ];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const TOL = 1e-9;

/** Keep the part of a convex polyhedron where n.x <= d (n unit length), the cut lying on plane `gen`. Returns the
 *  same faces when the plane misses it, null when nothing is left. */
function clip(faces, n, d, gen) {
    let any = false, all = true;
    for(let f of faces) for(let v of f.p) { let s = dot(n, v.x) - d; if(s > TOL) any = true; else all = false; }
    if(!any) return faces;
    if(all) return null;
    let out = [], cap = [];
    for(let f of faces) {
        let kept = [], m = f.p.length;
        for(let i = 0; i < m; i++) {
            let a = f.p[i], b = f.p[(i + 1) % m], da = dot(n, a.x) - d, db = dot(n, b.x) - d;
            if(da <= TOL) kept.push(a);
            if(Math.abs(da) <= TOL) { if(!cap.includes(a)) cap.push(a); }
            else if((da < -TOL && db > TOL) || (da > TOL && db < -TOL)) {
                // the edge a-b lies on this face's plane and one other both ends share; the new vertex is where the cut meets them
                let other = a.planes.find(q => q !== f.gen && b.planes.includes(q));
                let t = da / (da - db);
                let v = { x: [a.x[0] + (b.x[0] - a.x[0]) * t, a.x[1] + (b.x[1] - a.x[1]) * t, a.x[2] + (b.x[2] - a.x[2]) * t], planes: [f.gen, other, gen] };
                // the same edge is cut again from the face on its other side: reuse that vertex
                let same = cap.find(w => w.planes.includes(f.gen) && w.planes.includes(other) && w.planes.includes(gen));
                if(same) v = same; else cap.push(v);
                kept.push(v);
            }
        }
        if(kept.length >= 3) out.push({ gen: f.gen, n: f.n, p: kept });
    }
    if(cap.length >= 3) { // the cut face: its vertices ordered around their centroid, counter-clockwise seen from outside (along n)
        let c = [0, 0, 0];
        for(let v of cap) { c[0] += v.x[0] / cap.length; c[1] += v.x[1] / cap.length; c[2] += v.x[2] / cap.length; }
        let u = Math.abs(n[0]) < 0.9 ? [0, -n[2], n[1]] : [-n[2], 0, n[0]], ul = Math.hypot(u[0], u[1], u[2]);
        u = [u[0] / ul, u[1] / ul, u[2] / ul];
        let w = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
        let ang = v => { let r = [v.x[0] - c[0], v.x[1] - c[1], v.x[2] - c[2]]; return Math.atan2(dot(r, w), dot(r, u)); };
        out.push({ gen, n: [n[0], n[1], n[2]], p: cap.slice().sort((a, b) => ang(a) - ang(b)) });
    }
    return out.length >= 4 ? out : null;
}

/** The crater as a closed triangle mesh. Each inside seed's Voronoi cell is cut out of a cube of 1.3 times the longest
 *  reach by the bisector planes against every other seed; the crater's surface is every face of an inside cell that
 *  lies against an outside seed (or the cube). Faces two inside cells share are left out, which is the union without
 *  a boolean (a Manifold union of the cells' hulls took 7 ms). A vertex of the diagram is named by the four seeds (or
 *  cube planes) it is equidistant to, the same from every cell around it, so neighbouring faces share vertices
 *  exactly. Returns { positions, indices } or null. */
export function shatterMesh(center, reachAt, rng = Math.random) {
    let c = [center.x, center.y, center.z];
    let seeds = [], inside = 0, maxReach = 0;
    let at = (d, f) => { let r = reachAt(d); maxReach = Math.max(maxReach, r); return [c[0] + d[0] * r * f, c[1] + d[1] * r * f, c[2] + d[2] * r * f]; };
    // the centre itself, a little off, so the middle of the crater is always cut
    let r0 = reachAt([0, 1, 0]) * 0.1;
    seeds.push([c[0] + (rng() - 0.5) * r0, c[1] + (rng() - 0.5) * r0, c[2] + (rng() - 0.5) * r0]); inside++;
    for(let d of directions(N_IN, rng)) { seeds.push(at(jitter(d, 0.25, rng), 0.35 + rng() * 0.3)); inside++; }
    for(let d of directions(N_OUT, rng)) seeds.push(at(jitter(d, 0.2, rng), 1.22 + rng() * 0.45));
    let half = maxReach * 1.3;
    let positions = [], indices = [], ids = new Map();
    let vertex = (i, v) => {
        let k = [i, ...v.planes].sort((a, b) => a - b).join(',');
        let id = ids.get(k);
        if(id === undefined) { id = positions.length / 3; ids.set(k, id); positions.push(v.x[0], v.x[1], v.x[2]); }
        return id;
    };
    for(let i = 0; i < inside; i++) {
        let s = seeds[i];
        // nearest seeds first: they cut the most, and later planes mostly miss what is left
        let others = seeds.map((q, j) => [j, (q[0] - s[0]) ** 2 + (q[1] - s[1]) ** 2 + (q[2] - s[2]) ** 2]).filter(e => e[0] !== i).sort((a, b) => a[1] - b[1]);
        let faces = cube(c, half);
        for(let [j, d2] of others) {
            let q = seeds[j], l = Math.sqrt(d2);
            if(l < 1e-6) continue;
            let n = [(q[0] - s[0]) / l, (q[1] - s[1]) / l, (q[2] - s[2]) / l];
            faces = clip(faces, n, dot(n, [(q[0] + s[0]) / 2, (q[1] + s[1]) / 2, (q[2] + s[2]) / 2]), j);
            if(!faces) break;
        }
        if(!faces) continue;
        for(let f of faces) {
            if(f.gen >= 0 && f.gen < inside) continue; // shared with another inside cell: not on the surface
            let loop = f.p.map(v => vertex(i, v));
            for(let k = 1; k + 1 < loop.length; k++) indices.push(loop[0], loop[k], loop[k + 1]);
        }
    }
    if(!indices.length) return null;
    return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}
