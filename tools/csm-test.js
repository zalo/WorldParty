/** Standalone WebGPU page to find where three r186's CSMShadowNode loses its shadows under WorldParty's
 *  post-processing pipeline. Run: cp tools/csm-test.html public/ && npx esbuild tools/csm-test.js --bundle --format=esm --outfile=public/dist/csm-test.js (public/ is not tracked)
 *  Open /csm-test.html?mode=plain|pipe|mrt|traa&light=csm|sun|dir&env=0|1 */
import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, diffuseColor, velocity, packNormalToRGB } from 'three/tsl';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { SunLight } from 'three/addons/lights/SunLight.js';
import { SunLightNode } from 'three/addons/lights/SunLightNode.js';

const q = new URLSearchParams(location.search);
const mode = q.get('mode') || 'plain', lightKind = q.get('light') || 'csm', withEnv = q.get('env') === '1';
// WorldParty-like variants: move=1 repositions the light at camera + dir * 100 with the target on the camera every
// frame (DayCycle); near=<n> view camera near plane; layers=1 enableAll; cubepos=x,y,z puts the env capture away
// from the view; rebind=1 points csm.camera at the view camera after the first frame (World.update did this).
const move = q.get('move') === '1', rebind = q.get('rebind') === '1';
const near = q.has('near') ? parseFloat(q.get('near')) : 0.01;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87a0c0);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, near, 1000);
camera.position.set(0, 6, 18); camera.lookAt(0, 0, 0);
if(q.get('layers') === '1') camera.layers.enableAll();
scene.add(camera);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardNodeMaterial({ color: 0xb0a890 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
for(let i = 0; i < 6; i++) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 2), new THREE.MeshStandardNodeMaterial({ color: 0xc06040 }));
    box.position.set(-10 + i * 4, 2, (i % 2) * 4 - 2); box.castShadow = box.receiveShadow = true; scene.add(box);
}
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.6));

let light;
if(lightKind === 'sun') {
    light = new SunLight(0xffffff, 3); light.position.set(1, 1.5, 0.7).normalize();
    light.shadow.mapSize.set(2048, 2048); light.shadow.camera.far = 100; light.shadow.normalBias = 0.05;
} else {
    light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(30, 45, 21); light.target.position.set(0, 0, 0);
    light.shadow.mapSize.set(2048, 2048);
    if(lightKind === 'csm') {
        const csm = new CSMShadowNode(light, { cascades: 3, maxFar: 140, mode: 'practical', lightMargin: 120 });
        csm.fade = q.get('fade') !== '0';
        light.shadow.shadowNode = csm;
        window.csm = csm;
    } else {
        light.shadow.camera.left = -40; light.shadow.camera.right = 40; light.shadow.camera.top = 40; light.shadow.camera.bottom = -40;
        light.shadow.camera.near = 1; light.shadow.camera.far = 200;
    }
    scene.add(light.target);
}
light.castShadow = true;
scene.add(light);

const renderer = new THREE.WebGPURenderer();
renderer.library.addLight(SunLightNode, SunLight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

let pipeline = null;
if(mode !== 'plain') {
    pipeline = new THREE.RenderPipeline(renderer);
    const scenePass = pass(scene, camera);
    if(mode === 'mrt' || mode === 'traa') scenePass.setMRT(mrt({ output, diffuseColor, normal: packNormalToRGB(normalView), velocity }));
    const color = scenePass.getTextureNode('output');
    pipeline.outputNode = mode === 'traa' ? traa(color, scenePass.getTextureNode('depth'), scenePass.getTextureNode('velocity'), camera) : color;
}

// an environment cube capture before the main view, like WorldParty's sky Environment and probe bakes do
const cubeTarget = new THREE.CubeRenderTarget(64, { type: THREE.HalfFloatType });
const cubeCam = new THREE.CubeCamera(0.5, 100, cubeTarget);
cubeCam.position.set(0, 3, 0);
if(q.has('cubepos')) cubeCam.position.set(...q.get('cubepos').split(',').map(Number));
const sunDir = new THREE.Vector3(30, 45, 21).normalize();

window.frames = 0;
window.errors = [];
addEventListener('error', e => window.errors.push(String(e.message)));
await renderer.init();
renderer.setAnimationLoop(() => {
    if(move && !light.isSunLight) {
        light.target.position.copy(camera.position);
        light.position.copy(camera.position).addScaledVector(sunDir, 100);
        light.target.updateMatrixWorld();
    }
    if(withEnv) cubeCam.update(renderer, scene);
    if(rebind && window.csm && window.csm.camera && window.csm.camera !== camera) { window.csm.camera = camera; window.csm.updateFrustums(); }
    if(pipeline) pipeline.render(); else renderer.render(scene, camera);
    window.frames++;
});
window.scene = scene; window.renderer = renderer; window.camera = camera; window.light = light;
