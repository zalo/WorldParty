import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';

// Shared sky/lighting uniforms (the subset of tidewater's core/Globals.js the sky needs).
// Values are written by DayCycle every frame so every shader sees the same state.
export const G = {
	time: uniform( 0 ).setName( 'gTime' ), // simulation time (s)
	dt: uniform( 1 / 60 ).setName( 'gDt' ),

	// Sun (or moon at night) direction, pointing toward the light.
	sunDir: uniform( new THREE.Vector3( 0.3, 0.6, - 0.7 ).normalize() ).setName( 'gSunDir' ),
	// Radiance-scaled irradiance of the sun at sea level after atmospheric extinction.
	sunColor: uniform( new THREE.Color( 1, 1, 1 ) ).setName( 'gSunColor' ),
	// Hemispherical sky irradiance at sea level (cosine-weighted, divided by PI).
	skyIrradiance: uniform( new THREE.Color( 0.3, 0.4, 0.6 ) ).setName( 'gSkyIrr' ),
	// Average horizon sky color (fog / aerial perspective fallback).
	horizonColor: uniform( new THREE.Color( 0.6, 0.7, 0.8 ) ).setName( 'gHorizon' ),
	exposure: uniform( 1 ).setName( 'gExposure' ),
	// 0 = day, 1 = full night.
	night: uniform( 0 ).setName( 'gNight' ),
};
