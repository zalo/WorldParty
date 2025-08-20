import * as THREE from '../node_modules/three/build/three.module.js';
import Stats from '../node_modules/three/examples/jsm/libs/stats.module.js';
import { OrbitControls } from '../node_modules/three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from '../node_modules/three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '../node_modules/three/examples/jsm/postprocessing/RenderPass.js';
import { SSILVBPass } from './SSILVBPass.js';
import { OutputPass } from '../node_modules/three/examples/jsm/postprocessing/OutputPass.js';
import { CSM } from '../node_modules/three/examples/jsm/csm/CSM.js';
import { Sky } from '../node_modules/three/examples/jsm/objects/Sky.js';
import { RGBELoader } from '../node_modules/three/examples/jsm/loaders/RGBELoader.js';

/** The fundamental set up and animation structures for 3D Visualization */
export default class World {

    constructor(mainObject) { this._setupWorld(mainObject); }

    /** **INTERNAL**: Set up a basic world */
    _setupWorld(mainObject) {
        // app container div
        this.container = document.getElementById('appbody');
        document.body.appendChild(this.container);
        
        // camera and world
        this.scene = new THREE.Scene();
        //this.scene.background = new THREE.Color( 0x000000 );

        //this.sky = new Sky();
        //this.sky.scale.setScalar( 450000 );
        //this.scene.add( this.sky );

        this.camera = new THREE.PerspectiveCamera( 60, window.innerWidth / window.innerHeight, 0.01, 1000 );
        this.camera.position.set( -5.0, 5, 0 );
        this.camera.layers.enableAll();
        this.scene.add(this.camera);

        //this.spotLight = new THREE.SpotLight( 0xffffff, Math.PI * 10.0 );
        //this.spotLight.angle = Math.PI / 5;
        //this.spotLight.penumbra = 0.2;
        //this.spotLight.position.set( -2, 3, -3 );
        //this.spotLight.castShadow = true;
        //this.spotLight.shadow.camera.near = 1;
        //this.spotLight.shadow.camera.far = 20;
        //this.spotLight.shadow.mapSize.width = 1024;
        //this.spotLight.shadow.mapSize.height = 1024;
        //this.scene.add( this.spotLight );

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
        this.dirLight.shadow.bias = -0.001;
        this.scene.add( this.dirLight );

       //this.csm = new CSM( {
		//			maxFar: 1000,
		//			cascades: 4,
		//			mode: 'practical',
		//			parent: this.scene,
		//			shadowMapSize: 1024,
		//			lightDirection: new THREE.Vector3( 0, -1, 0 ).normalize(),
		//			camera: this.camera
		//		} );
       //this.csm.updateFrustums();
       //this.csm.update();
        
        this.hemiLight = new THREE.HemisphereLight( 0xffffff, 0x444444, 3.0 );
        this.hemiLight.position.set( 0, 20, 0 );
        this.scene.add( this.hemiLight );

        new THREE.TextureLoader()
			.load( 'assets/Starry night preview4.png', ( texture, textureData ) => {
				texture.mapping = THREE.EquirectangularReflectionMapping;
				texture.colorSpace = THREE.SRGBColorSpace;
                this.scene.background = texture;
                this.scene.environment = texture;
			} );

        //const textureLoader = new THREE.TextureLoader();

	    //let textureEquirec = textureLoader.load( 'assets/moonless_golf_2k.hdr.jpg' );
	    //textureEquirec.mapping = THREE.EquirectangularReflectionMapping;
	    //textureEquirec.colorSpace = THREE.SRGBColorSpace;

	    //this.scene.background = textureEquirec;

        // Geometry

        //this.ground = new THREE.Mesh(
        //    new THREE.PlaneGeometry( 20, 20, 1, 1 ),
        //    new THREE.MeshPhongMaterial( { color: 0xa0adaf, shininess: 150 } )
        //);				
        //this.ground.rotation.x = - Math.PI / 2; // rotates X/Y to X/Z
        //this.ground.receiveShadow = true;
        //this.scene.add( this.ground );
        
        //this.helper = new THREE.GridHelper( 100, 20 );
        //this.helper.material.opacity = 1.0;
        //this.helper.material.transparent = true;
        //this.helper.position.set(0, 0.005, 0);
        //this.scene.add( this.helper );

        // renderer
        this.renderer = new THREE.WebGLRenderer( { antialias: true } ); //, alpha: true
        this.renderer.setPixelRatio( window.devicePixelRatio );
        this.renderer.shadowMap.enabled = true;
        this.container.appendChild(this.renderer.domElement);
        this.renderer.setAnimationLoop(mainObject.update.bind(mainObject));
        this.renderer.setClearColor( 0x000000, 0 ); // the default
        window.addEventListener('resize', this._onWindowResize.bind(this), false);
        window.addEventListener('orientationchange', this._onWindowResize.bind(this), false);

        this.composer = new EffectComposer( this.renderer );

        const renderPass = new RenderPass( this.scene, this.camera );
        this.composer.addPass( renderPass );

        const ssilvbPass = new SSILVBPass( this.scene, this.camera, window.innerWidth, window.innerHeight );
        //ssilvbPass.output = SSILVBPass.OUTPUT.AO;
        this.composer.addPass( ssilvbPass );

        const outputPass = new OutputPass();
        this.composer.addPass( outputPass );

        this._onWindowResize();

        //this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        //this.controls.target.set(0, 0, 0);
        //this.controls.panSpeed = 2;
        //this.controls.zoomSpeed = 1;
        //this.controls.enableDamping = true;
        //this.controls.dampingFactor = 0.10;
        //this.controls.screenSpacePanning = true;
        //this.controls.update();
        //this.controls.addEventListener('change', () => this.viewDirty = true);

        // raycaster
        this.raycaster = new THREE.Raycaster();
        this.raycaster.layers.set(0);

        // stats
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
        if(this.composer){this.composer.setSize(width, height);}
    }

}