/** The terrain material shared by chunks and fragments: per-face vertex colour, and for textured materials a
 *  layer of the world's texture array sampled either by the mesh UVs (imported worlds) or triplanar from a
 *  position (`tile` attribute > 0: tiles per metre), with the vertex colour as a tint. Chunks sample by world
 *  position; fragments by local position so the texture rides along with the piece. */
import * as THREE from 'three/webgpu';
import { attribute, texture, uv, select, vertexColor, positionWorld, positionLocal, normalWorld, normalLocal, float, vec3 } from 'three/tsl';

/** @param {THREE.DataArrayTexture} arrayTexture the world's texture layers (TerrainTextures)
 *  @param {'world'|'local'} space which position (and normal) the triplanar projection uses */
export function makeTerrainMaterial(arrayTexture, space = 'world', debug = false) {
    // normals come from the geometry (per face, blended across smooth materials: buildTerrainGeometry), not from derivatives
    let material = debug === 6 ? new THREE.MeshBasicNodeMaterial() : new THREE.MeshStandardNodeMaterial({ roughness: 0.75, metalness: 0.05 }); // 6: unlit
    const slot = attribute('slot', 'float');
    const tile = attribute('tile', 'float');
    const layer = slot.add(0.5).toInt(); // round: the interpolated float lands a hair under the integer on some pixels, which truncation turned into the previous layer
    const p = (space === 'world' ? positionWorld : positionLocal).mul(tile);
    const n = (space === 'world' ? normalWorld : normalLocal).abs().pow(4.0);
    const w = n.div(n.x.add(n.y).add(n.z).max(1e-5));
    const sx = texture(arrayTexture, p.zy).depth(layer);
    const sy = texture(arrayTexture, p.xz).depth(layer);
    const sz = texture(arrayTexture, p.xy).depth(layer);
    const triplanar = sx.rgb.mul(w.x).add(sy.rgb.mul(w.y)).add(sz.rgb.mul(w.z));
    const byUv = texture(arrayTexture, uv()).depth(layer).rgb;
    const sampled = select(tile.greaterThan(0.0), triplanar, byUv);
    material.colorNode = select(slot.lessThan(0.0), vertexColor(), sampled.mul(vertexColor()));
    // ?tridebug=N: 1 projection weights as RGB (x red, y green, z blue); 2 layer index as grey; 3/4/5 only the xy / zy / xz sample
    if(debug === 1) material.colorNode = vec3(w.x, w.y, w.z);
    else if(debug === 2) material.colorNode = vec3(slot.add(1.0).div(13.0));
    else if(debug === 3) material.colorNode = sz.rgb;
    else if(debug === 4) material.colorNode = sx.rgb;
    else if(debug === 5) material.colorNode = sy.rgb;
    return material;
}
