import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, diffuseColor, velocity, add, vec3, vec4, directionToColor, colorToDirection, sample } from 'three/tsl';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import Stats from 'three/examples/jsm/libs/stats.module.js';

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

        this.dirLight = new THREE.DirectionalLight( 0x55505a, Math.PI * 10.0 );
        this.dirLight.position.set( 3, 3, 0 );
        this.dirLight.rotateX( 2 );
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

        this.hemiLight = new THREE.HemisphereLight( 0xffffff, 0x444444, 3.0 );
        this.hemiLight.position.set( 0, 20, 0 );
        this.scene.add( this.hemiLight );

        new THREE.TextureLoader()
            .load( 'assets/skybox.png', ( texture ) => {
                texture.mapping = THREE.EquirectangularReflectionMapping;
                texture.colorSpace = THREE.SRGBColorSpace;
                this.scene.background = texture;
                this.scene.environment = texture;
            } );

        // Mobile renders at half resolution
        let pixelRatio = this.isMobile ? Math.max(0.5, window.devicePixelRatio * 0.25) : Math.min(1, window.devicePixelRatio);

        // WebGPU Renderer — no hardware AA since TRAA handles it
        this.renderer = new THREE.WebGPURenderer();
        this.renderer.setPixelRatio( pixelRatio );
        this.renderer.shadowMap.enabled = true;
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
            normal: directionToColor( normalView ),
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
            return colorToDirection( scenePassNormal.sample( uv ) );
        } );

        // SSGI pass with temporal filtering enabled
        this.giPass = ssgi( scenePassColor, scenePassDepth, sceneNormal, this.camera );
        this.giPass.useTemporalFiltering = true;
        if(this.isMobile) {
            this.giPass.sliceCount.value = 1;
            this.giPass.stepCount.value = 8;
        } else {
            this.giPass.sliceCount.value = 2;
            this.giPass.stepCount.value = 8;
        }

        const gi = this.giPass.rgb;
        const ao = this.giPass.a;

        // Composite: direct lighting * AO + diffuse * GI
        const compositePass = vec4( add( scenePassColor.rgb.mul( ao ), scenePassDiffuse.rgb.mul( gi ) ), scenePassColor.a );

        // TRAA: temporal resolve anti-aliasing using velocity buffer
        const traaPass = traa( compositePass, scenePassDepth, scenePassVelocity, this.camera );

        this.renderPipeline.outputNode = traaPass;

        this._onWindowResize();

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

    /** **INTERNAL**: This function recalculates the viewport based on the new window size. */
    _onWindowResize() {
        let width = window.innerWidth, height = window.innerHeight;
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
    }

}
