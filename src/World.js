import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, diffuseColor, velocity, add, vec4, packNormalToRGB, unpackRGBToNormal, sample } from 'three/tsl';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import Stats from 'three/examples/jsm/libs/stats.module.js';
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

        this.dirLight = new THREE.DirectionalLight( 0xffffff, Math.PI * 3.0 );
        this.dirLight.position.set( 30, 60, -70 );
        this.dirLight.castShadow = true;
        this.dirLight.shadow.camera.near  = -100;
        this.dirLight.shadow.camera.far   = 100;
        this.dirLight.shadow.camera.right = 30;
        this.dirLight.shadow.camera.left  = - 30;
        this.dirLight.shadow.camera.top	  = 30;
        this.dirLight.shadow.camera.bottom = - 30;
        this.dirLight.shadow.mapSize.width  = 2048;
        this.dirLight.shadow.mapSize.height = 2048;
        this.dirLight.shadow.bias = -0.0002;
        this.dirLight.shadow.normalBias = 0.02;
        this.scene.add( this.dirLight );
        this.scene.add( this.dirLight.target );

        // Mobile renders at half resolution
        let pixelRatio = this.isMobile ? Math.max(0.5, window.devicePixelRatio * 0.25) : Math.min(1, window.devicePixelRatio);

        // WebGPU Renderer — no hardware AA since TRAA handles it
        this.renderer = new THREE.WebGPURenderer();
        this.renderer.setPixelRatio( pixelRatio );
        this.renderer.shadowMap.enabled = true;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 0.55;
        this.container.appendChild(this.renderer.domElement);
        this.renderer.setAnimationLoop(mainObject.update.bind(mainObject));
        this.renderer.setClearColor( 0x000000, 0 );
        window.addEventListener('resize', this._onWindowResize.bind(this), false);
        window.addEventListener('orientationchange', this._onWindowResize.bind(this), false);

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

        // SSGI pass with temporal filtering enabled
        this.giPass = ssgi( scenePassColor, scenePassDepth, sceneNormal, this.camera );
        // Debug toggles: ?traa=0 skips the temporal AA, ?gi=0 skips SSGI, ?probes=0 skips the probe grid
        let flags = mainObject.queryParams || new URLSearchParams();
        this.giPass.useTemporalFiltering = flags.get('gitemporal') !== '0';
        if(this.isMobile) {
            this.giPass.sliceCount.value = 1;
            this.giPass.stepCount.value = 8;
        } else {
            this.giPass.sliceCount.value = 2;
            this.giPass.stepCount.value = 8;
        }

        const gi = this.giPass.getGINode();
        const ao = this.giPass.getAONode();

        // Composite: direct lighting * AO + diffuse * GI
        const compositePass = flags.get('gi') === '0' ? scenePassColor : vec4( add( scenePassColor.rgb.mul( ao ), scenePassDiffuse.rgb.mul( gi.rgb ) ), scenePassColor.a );

        // TRAA: temporal resolve anti-aliasing using velocity buffer
        const traaPass = traa( compositePass, scenePassDepth, scenePassVelocity, this.camera );

        this.renderPipeline.outputNode = flags.get('traa') === '0' ? compositePass : traaPass;

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

    /** Physically based sky + sun (needs WebGPU); otherwise the static skybox image and a hemisphere light. */
    _setupSky(mainObject) {
        let params = mainObject.queryParams;
        let timeOfDay = params && params.has('time') ? parseFloat(params.get('time')) : 10;
        let dayLengthMinutes = params && params.has('daylength') ? parseFloat(params.get('daylength')) : 0;
        this.renderer.init().then(() => {
            if(DayCycle.supported(this.renderer)) {
                this.dayCycle = new DayCycle(this.renderer, this.scene, this.dirLight, { timeOfDay, dayLengthMinutes });
                if(ProbeLighting.supported(this.renderer) && !(params && params.get('probes') === '0')) {
                    this.probes = new ProbeLighting(this.renderer, this.scene, { spacing: this.isMobile ? 8 : 5 });
                    // the probes carry the sky's diffuse light; keep the environment map for reflections
                    this.scene.environmentIntensity = 0.3;
                    mainObject.attachProbes?.(this.probes);
                }
                return;
            }
            console.warn('DayCycle needs WebGPU; using the static skybox');
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
        if(this.probes) this.probes.update();
    }

    /** **INTERNAL**: This function recalculates the viewport based on the new window size. */
    _onWindowResize() {
        let width = window.innerWidth, height = window.innerHeight;
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
    }

}
