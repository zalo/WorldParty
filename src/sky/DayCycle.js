/** Physically based sky and sun for the scene: tidewater's Hillaire atmosphere
 *  (sky view / transmittance / multiple scattering LUTs in compute), sun disk,
 *  stars and moon at night, rendered as the scene background and prefiltered
 *  into scene.environment for image based lighting. The directional light's
 *  colour follows the sun's transmittance read back from the GPU.
 *
 *  Needs the WebGPU backend (compute kernels, storage textures); callers should
 *  check `DayCycle.supported(renderer)` and keep a static fallback otherwise. */
import * as THREE from 'three/webgpu';
import { Atmosphere, SUN_ILLUMINANCE } from './Atmosphere.js';
import { Sky, sunDirectionFromTime } from './Sky.js';
import { Environment } from './Environment.js';
import { G } from './Globals.js';

const _up = new THREE.Vector3( 0, 1, 0 );

export class DayCycle {

	static supported( renderer ) { return !! ( renderer.backend && renderer.backend.isWebGPUBackend ); }

	/**
	 * @param {THREE.WebGPURenderer} renderer
	 * @param {THREE.Scene} scene
	 * @param {THREE.DirectionalLight} sun - the key light; its colour, position and target are driven here
	 * @param {{ timeOfDay?: number, azimuth?: number, dayLengthMinutes?: number, latitude?: number }} [opts]
	 */
	constructor( renderer, scene, sun, opts = {} ) {

		this.renderer = renderer;
		this.scene = scene;
		this.sun = sun;
		this.timeOfDay = opts.timeOfDay ?? 10;          // hours
		this.azimuth = opts.azimuth ?? 0;               // degrees, rotates the sun path
		this.dayLengthMinutes = opts.dayLengthMinutes ?? 0; // 0 = frozen time of day
		this.latitude = opts.latitude ?? 24;
		// the key light relative to the physical sun: a little under, so sunlit sand and cobbles keep texture
		// under ACES while the sky-lit shade (boosted in ProbeLighting) is not left behind
		this.sunScale = opts.sunScale ?? 0.85;
		this.time = 0;

		this.atmosphere = new Atmosphere( renderer );
		this.sky = new Sky( this.atmosphere );
		scene.backgroundNode = this.sky.backgroundNode();
		this.environment = new Environment( renderer, scene, this.sky );
		this.updateSun();

	}

	setTimeOfDay( hours ) { this.timeOfDay = ( ( hours % 24 ) + 24 ) % 24; }

	updateSun() {

		const dir = sunDirectionFromTime( this.timeOfDay, this.latitude ).applyAxisAngle( _up, THREE.MathUtils.degToRad( this.azimuth ) );
		// the sky is always scattered sunlight, even with the sun below the horizon (twilight)
		this.atmosphere.sunDir.value.copy( dir );
		// below the horizon the moon takes over as the key light
		const night = THREE.MathUtils.smoothstep( - dir.y, 0.02, 0.18 );
		G.night.value = night;
		this.sky.starIntensity.value = night;
		const moon = new THREE.Vector3( - dir.x, Math.abs( dir.y ) * 0.8 + 0.25, - dir.z ).normalize();
		this.sky.moonDir.value.copy( moon );
		const light = dir.y > - 0.07 ? dir : moon;
		G.sunDir.value.copy( light );
		this.light = light;

	}

	applyReadback() {

		const a = this.atmosphere;
		if ( ! a.sunTransmittance ) return;
		const sunTrue = a.sunDir.value;
		const sunUp = sunTrue.y > - 0.07;
		const T = a.sunTransmittance;
		const horizonFade = THREE.MathUtils.smoothstep( sunTrue.y, - 0.03, 0.02 );
		let c;
		if ( sunUp ) c = new THREE.Color( T[ 0 ], T[ 1 ], T[ 2 ] ).multiplyScalar( SUN_ILLUMINANCE * horizonFade );
		else c = new THREE.Color( 0.6, 0.7, 1.0 ).multiplyScalar( 0.12 * G.night.value );
		G.sunColor.value.copy( c );
		this.sun.color.copy( c );
		this.sun.intensity = this.sunScale;
		const irr = a.skyIrradiance;
		const nightAmb = 0.012 * G.night.value;
		G.skyIrradiance.value.setRGB( irr[ 0 ] + nightAmb * 0.6, irr[ 1 ] + nightAmb * 0.7, irr[ 2 ] + nightAmb );
		G.horizonColor.value.setRGB( a.horizon[ 0 ], a.horizon[ 1 ], a.horizon[ 2 ] );

	}

	/** Once per frame, before rendering. */
	update( dt, camera ) {

		this.time += dt;
		G.time.value = this.time;
		G.dt.value = dt;
		if ( this.dayLengthMinutes > 0 ) this.setTimeOfDay( this.timeOfDay + dt * 24 / ( this.dayLengthMinutes * 60 ) );
		this.updateSun();

		if ( this.sun.isSunLight ) {

			// a SunLight is a direction (its position); its cascades are fitted to the view camera every render
			this.sun.position.copy( this.light );

		} else {

			// keep the shadow frustum centred on the camera
			this.sun.target.position.copy( camera.position );
			this.sun.position.copy( camera.position ).addScaledVector( this.light, 100 );
			this.sun.target.updateMatrixWorld();

		}

		this.atmosphere.update( dt, camera.position.y );
		this.applyReadback();
		this.environment.update( dt );

	}

}
