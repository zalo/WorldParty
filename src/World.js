import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, diffuseColor, velocity, add, vec4, packNormalToRGB, unpackRGBToNormal, sample, fog, densityFogFactor, uniform } from 'three/tsl';
import { G } from './sky/Globals.js';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import Stats from 'three/examples/jsm/libs/stats.module.js';
import { SunLight } from 'three/addons/lights/SunLight.js';
import { SunLightNode } from 'three/addons/lights/SunLightNode.js';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { DayCycle } from './sky/DayCycle.js';
import { ProbeLighting } from './client/ProbeLighting.js';

/** The fundamental set up and animation structures for 3D Visualization */
export default class World {

    constructor(mainObject, isMobile) {
        this.isMobile = isMobile;
        this._setupWorld(mainObject);
    }

    /** **INTERNAL**: Set up a basic world */
    _setupWorld(mainObject) {
        this.container = document.getElementById('appbody');
        document.body.appendChild(this.container);

        this.scene = new THREE.Scene();

        this.camera = new THREE.PerspectiveCamera( 60, window.innerWidth / window.innerHeight, 0.01, 1000 );
        this.camera.position.set( -5.0, 5, 0 );
        this.camera.layers.enableAll();
        this.scene.add(this.camera);

        // The sun: three's SunLight (r186), a directional light with two view-fitted shadow cascades in one atlas
        // (near cascade to ~33 m at 2 cm texels, far cascade to CSM_FAR at ~7 cm, blended over a fade band, texel
        // snapped against shimmer). The light's position is its direction (DayCycle sets it); there is no target.
        // The older CSMShadowNode addon never drew a shadow here; SunLight is the supported path in this three
        // version and the probe bake knows to swap it for a fitted plain light while it captures.
        // ?csm=0 falls back to one 180 m shadow box (4096², 4 cm texels) centred on the player by DayCycle.
        let params = mainObject.queryParams || new URLSearchParams();
        const CSM_FAR = 130;   // shadows reach this far from the camera: the far fort from the walkway of the other
        let mapSize = this.isMobile ? 2048 : 4096;
        this.cascaded = params.get('csm') !== '0' && params.get('csm') !== 'old';
        if(this.cascaded) {
            this.dirLight = new SunLight( 0xffffff, 1 );
            this.dirLight.position.set( 30, 60, -70 ).normalize();
            this.dirLight.castShadow = true;
            this.dirLight.shadow.mapSize.set( mapSize, mapSize ); // per cascade
            this.dirLight.shadow.camera.far = CSM_FAR;
            this.dirLight.shadow.camera.near = 1;
        } else {
            this.dirLight = new THREE.DirectionalLight( 0xffffff, 1 );
            this.dirLight.position.set( 30, 60, -70 );
            this.dirLight.castShadow = true;
            this.dirLight.shadow.mapSize.set( mapSize, mapSize );
            if(params.get('csm') === 'old') {
                // the CSMShadowNode addon, kept only to reproduce its failure here (it works in a bare scene: tools/csm-test.js)
                this.csm = new CSMShadowNode( this.dirLight, { cascades: 3, maxFar: 140, mode: 'practical', lightMargin: 120 } );
                this.csm.fade = true;
                this.dirLight.shadow.shadowNode = this.csm;
            } else {
                this.dirLight.shadow.camera.near = 1; this.dirLight.shadow.camera.far = 400;
                this.dirLight.shadow.camera.left = -90; this.dirLight.shadow.camera.right = 90;
                this.dirLight.shadow.camera.top = 90; this.dirLight.shadow.camera.bottom = -90;
            }
            this.scene.add( this.dirLight.target );
        }
        // Terrain casts with its front faces (terrainMaterial.js), so a constant bias is not needed; the normal
        // offset keeps lit surfaces off their own map (about a texel of the far cascade at grazing angles).
        this.dirLight.shadow.bias = 0;
        this.dirLight.shadow.normalBias = 0.06;
        this.dirLight.shadow.radius = 1.5;   // texels of the 5 tap PCF disk (rotated per pixel by a noise TRAA resolves; set to 1 on the direct path below)
        this.scene.add( this.dirLight );

        // Two ways to draw a frame. Desktop: the post-processing pipeline (scene pass into MRT targets, TRAA, optional
        // SSGI). Mobile, or ?traa=0: `renderer.render` straight to the canvas with 4x MSAA; the renderer still tone maps
        // and converts to sRGB in its output pass (one half-float target), so the image matches minus the temporal AA.
        // TRAA blurred a phone's already small frame, and the MRT targets (four colour attachments) plus the TRAA history
        // are a lot of bandwidth for a tiled mobile GPU. ?direct=0|1 forces either; ?gi=1 needs the pipeline.
        let flagsIn = mainObject.queryParams || new URLSearchParams();
        this.direct = flagsIn.get('gi') !== '1' && (flagsIn.has('direct') ? flagsIn.get('direct') === '1' : (this.isMobile || flagsIn.get('traa') === '0'));

        // Pixel ratio: CSS pixels on mobile (it was a quarter of the device ratio, 0.75 on a DPR 3 phone, which with TRAA
        // on top was most of the blur), at most the device ratio on desktop. ?dpr=<n> overrides.
        let pixelRatio = flagsIn.has('dpr') ? parseFloat(flagsIn.get('dpr')) : (this.isMobile ? 1 : Math.min(1, window.devicePixelRatio));

        // WebGPU Renderer: MSAA only on the direct path (the pipeline's TRAA does the anti-aliasing there)
        this.renderer = new THREE.WebGPURenderer({ antialias: this.direct, trackTimestamp: flagsIn.get('gputime') === '1' }); // ?gputime=1: GPU timestamps (renderer.resolveTimestampsAsync)
        if(this.direct) this.dirLight.shadow.radius = 1; // without TRAA the per-pixel rotation of the PCF disk shows as dither at shadow edges
        this.renderer.library.addLight( SunLightNode, SunLight );
        this.renderer.setPixelRatio( pixelRatio );
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft is gone in r186 (the renderer substitutes this one, with a warning)
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        // Exposure sits where sunlit cobbles and sand land around 190/255 after ACES (0.55 blew them out to 230,
        // and crushed the shade); the ambient multiplier in ProbeLighting and DayCycle's sunScale set the ratio.
        this.renderer.toneMappingExposure = 0.42;
        this.container.appendChild(this.renderer.domElement);
        this.renderer.setAnimationLoop(mainObject.update.bind(mainObject));
        this.renderer.setClearColor( 0x000000, 0 );
        window.addEventListener('resize', this._onWindowResize.bind(this), false);
        window.addEventListener('orientationchange', this._onWindowResize.bind(this), false);

        let flags = mainObject.queryParams || new URLSearchParams();
        if(!this.direct) this._setupPipeline(flags);

        // Aerial perspective: a thin haze in the sky's horizon colour (the same radiance units as the sky, so it
        // tone maps with it), 1 - exp(-(d k)^2): 3% at 50 m, 12% at 100 m, 25% at 150 m. It separates the far
        // fort from the near one and keeps distant shaded rock from reading as a black cutout. ?fog=0 / ?fog=<k>.
        let fogDensity = flags.has('fog') ? parseFloat(flags.get('fog')) : 0.0036;
        if(fogDensity > 0) {
            this.fogDensity = uniform(fogDensity);
            this.scene.fogNode = fog(G.horizonColor, densityFogFactor(this.fogDensity));
        }

        this._onWindowResize();
        this._setupSky(mainObject);

        // Raycaster
        this.raycaster = new THREE.Raycaster();
        this.raycaster.layers.set(0);

        // Stats
        this.stats = new Stats();
        this.stats.dom.style.transform = "scale(0.7);";
        this.container.appendChild(this.stats.dom);

        // Temp variables to reduce allocations
        this.mat  = new THREE.Matrix4();
        this.vec = new THREE.Vector3();
        this.zVec = new THREE.Vector3(0, 0, 1);
        this.quat = new THREE.Quaternion().identity();
        this.color = new THREE.Color();
    }

    /** Draw the frame: the post-processing pipeline, or straight to the canvas (see `direct`). */
    renderFrame() {
        if(this.direct) this.renderer.render(this.scene, this.camera);
        else this.renderPipeline.render();
    }

    /** **INTERNAL**: the post-processing pipeline (desktop): scene pass into MRT targets, optional SSGI, TRAA. */
    _setupPipeline(flags) {
        // Post-processing: SSGI + TRAA via RenderPipeline
        this.renderPipeline = new THREE.RenderPipeline( this.renderer );

        const scenePass = pass( this.scene, this.camera );
        scenePass.setMRT( mrt( {
            output: output,
            diffuseColor: diffuseColor,
            normal: packNormalToRGB( normalView ),
            velocity: velocity
        } ) );

        const scenePassColor = scenePass.getTextureNode( 'output' );
        const scenePassDiffuse = scenePass.getTextureNode( 'diffuseColor' );
        const scenePassDepth = scenePass.getTextureNode( 'depth' );
        const scenePassNormal = scenePass.getTextureNode( 'normal' );
        const scenePassVelocity = scenePass.getTextureNode( 'velocity' );

        // Bandwidth optimization: use lower precision for diffuse and normals
        const diffuseTexture = scenePass.getTexture( 'diffuseColor' );
        diffuseTexture.type = THREE.UnsignedByteType;
        const normalTexture = scenePass.getTexture( 'normal' );
        normalTexture.type = THREE.UnsignedByteType;

        const sceneNormal = sample( ( uv ) => {
            return unpackRGBToNormal( scenePassNormal.sample( uv ) );
        } );

        // Toggles: ?traa=0 skips the temporal AA (the direct path, unless ?direct=0), ?probes=0 skips the probe grid,
        // ?gi=1 adds screen-space GI on top. SSGI is off by default: the probe grid carries the bounce light, and the
        // screen-space pass cost a large share of the frame for a smeary, view-dependent gain.
        let compositePass = scenePassColor;
        if(flags.get('gi') === '1') {
            this.giPass = ssgi( scenePassColor, scenePassDepth, sceneNormal, this.camera );
            this.giPass.useTemporalFiltering = flags.get('gitemporal') !== '0';
            this.giPass.sliceCount.value = this.isMobile ? 1 : 2;
            this.giPass.stepCount.value = 8;
            const gi = this.giPass.getGINode();
            const ao = this.giPass.getAONode();
            // Composite: direct lighting * AO + diffuse * GI
            compositePass = vec4( add( scenePassColor.rgb.mul( ao ), scenePassDiffuse.rgb.mul( gi.rgb ) ), scenePassColor.a );
        }

        // TRAA: temporal resolve anti-aliasing using velocity buffer
        const traaPass = traa( compositePass, scenePassDepth, scenePassVelocity, this.camera );

        this.renderPipeline.outputNode = flags.get('traa') === '0' ? compositePass : traaPass;
    }

    /** Physically based sky + sun (needs WebGPU); otherwise the static skybox image and a hemisphere light. */
    _setupSky(mainObject) {
        let params = mainObject.queryParams;
        let timeOfDay = params && params.has('time') ? parseFloat(params.get('time')) : 10;
        let dayLengthMinutes = params && params.has('daylength') ? parseFloat(params.get('daylength')) : 0;
        this.renderer.init().then(() => {
            if(DayCycle.supported(this.renderer)) {
                this.dayCycle = new DayCycle(this.renderer, this.scene, this.dirLight, { timeOfDay, dayLengthMinutes });
                if(ProbeLighting.supported(this.renderer) && !(params && params.get('probes') === '0')) {
                    // a probe costs ~4 ms of CPU to bake here with the terrain batched (12 ms before), several times that on a phone:
                    // mobile gets a coarser grid, one probe at a time and a 2 ms budget (it rests between probes that overrun it)
                    this.probes = new ProbeLighting(this.renderer, this.scene, this.isMobile ? { spacing: 8, maxProbes: 1500, perFrame: 1, budgetMs: 2 } : { spacing: 6, maxProbes: 4000 });
                    // the probes carry the sky's diffuse light once baked; until then the environment map does (ProbeLighting.environmentIntensity)
                    mainObject.attachProbes?.(this.probes);
                }
                mainObject.attachGI?.();
                return;
            }
            console.warn('DayCycle needs WebGPU; using the static skybox');
            mainObject.attachGI?.(); // (no vertex GI here; this tells the game the glow volume lights the crystals)
            this.hemiLight = new THREE.HemisphereLight( 0xffffff, 0x444444, 3.0 );
            this.scene.add( this.hemiLight );
            this.dirLight.color.setHex(0xfff2e0);
            new THREE.TextureLoader().load( 'assets/skybox.png', ( texture ) => {
                texture.mapping = THREE.EquirectangularReflectionMapping;
                texture.colorSpace = THREE.SRGBColorSpace;
                this.scene.background = texture;
                this.scene.environment = texture;
            } );
        });
    }

    /** Once per frame before rendering. */
    update(dt) {
        if(this.dayCycle) this.dayCycle.update(dt, this.camera);
        if(this.probes) { this.probes.update(this.camera); this.scene.environmentIntensity = this.probes.environmentIntensity(); }
        // ?csm=old: why the addon drew nothing here. It clones the sun's LightShadow for each cascade when the first
        // material is built with it, and that build happens inside a probe bake, which has just set every shadow
        // casting light to autoUpdate=false / needsUpdate=true (LightProbeGrid.bake); LightShadow.copy carries both
        // flags, so the cascade maps rendered exactly once, from the probe's cube camera, and never again. It also
        // adopts that cube camera as the view camera. Undo both every frame.
        if(this.csm) {
            if(this.csm.camera && this.csm.camera !== this.camera) { this.csm.camera = this.camera; this.csm.updateFrustums(); }
            for(let l of this.csm.lights) l.shadow.autoUpdate = true;
        }
    }

    /** **INTERNAL**: This function recalculates the viewport based on the new window size. */
    _onWindowResize() {
        let width = window.innerWidth, height = window.innerHeight;
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
    }

}
