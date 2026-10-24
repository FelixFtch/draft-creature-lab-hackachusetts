import * as THREE from 'three';

// One onBeforeCompile patch shared by every creature material. It adds, with
// no UVs and no textures:
//  - procedural patterns evaluated in object space (torso, head and shell are
//    built in the torso body frame, so spots continue across them; limbs use
//    their own frame so stripes wrap around each segment),
//  - a faint FDM layer-line bump (a nod to 3D printing) that fades out
//    before it can alias,
//  - the print-reveal: a rising cut in world height, a glowing fresh layer
//    and a gyroid "infill" on the inside faces.
// Pattern kind and features are #defines, so each program only contains the
// code it uses; the function source is shared so three caches programs.

export const PATTERN_IDS = { none: 0, spots: 1, dots: 2, stripes: 3, bands: 4, gradient: 5, checker: 6, camo: 7, panels: 8, cracks: 9, scales: 10, hex: 11 };

const VERTEX_PARS = /* glsl */`
varying vec3 vLookObj;
varying vec3 vLookObjN;
varying vec3 vLookWorld;
varying vec3 vLookLayerDir;
`;

const VERTEX_MAIN = /* glsl */`
{
  vec4 lookP = vec4( transformed, 1.0 );
  vec3 lookN = objectNormal;
  mat3 lookBasis = mat3( 1.0 );
  #ifdef USE_INSTANCING
    lookP = instanceMatrix * lookP;
    lookBasis = mat3( instanceMatrix );
    lookN = lookBasis * lookN;
  #endif
  vLookObj = lookP.xyz;
  vLookObjN = lookN;
  vLookWorld = ( modelMatrix * lookP ).xyz;
  vLookLayerDir = normalize( normalMatrix * ( lookBasis * vec3( 0.0, 0.0, 1.0 ) ) );
}
`;

const FRAGMENT_PARS = /* glsl */`
varying vec3 vLookObj;
varying vec3 vLookObjN;
varying vec3 vLookWorld;
varying vec3 vLookLayerDir;
uniform vec3 uLookPatColor;
uniform vec3 uLookPatColor2;
uniform float uLookPatFreq;
uniform vec3 uLookPatAxis;
uniform vec2 uLookPatRange;
uniform float uLookPatGlow;
uniform float uLookLayerAmp;
uniform float uLookLayerPitch;
uniform vec4 uLookReveal;        // x: cut height (world y), y: glow band, z: on, w: time
uniform vec3 uLookRevealColor;
uniform vec3 uLookInfillColor;
float lookMask = 0.0;
vec2 lookMask2 = vec2( 0.0 );

float lkHash( vec3 p ) { return fract( sin( dot( p, vec3( 127.1, 311.7, 74.7 ) ) ) * 43758.5453123 ); }
vec3 lkHash3( vec3 p ) { return vec3( lkHash( p ), lkHash( p + 19.19 ), lkHash( p + 47.77 ) ); }
float lkNoise( vec3 p ) {
  vec3 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( mix( lkHash( i ), lkHash( i + vec3( 1, 0, 0 ) ), f.x ), mix( lkHash( i + vec3( 0, 1, 0 ) ), lkHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
              mix( mix( lkHash( i + vec3( 0, 0, 1 ) ), lkHash( i + vec3( 1, 0, 1 ) ), f.x ), mix( lkHash( i + vec3( 0, 1, 1 ) ), lkHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
}
float lkFbm( vec3 p ) { float s = 0.0, a = 0.5; for ( int i = 0; i < 4; i ++ ) { s += a * lkNoise( p ); p = p * 2.07 + 13.7; a *= 0.5; } return s; }
vec2 lkWorley( vec3 p, out float id ) {
  vec3 i = floor( p ), f = fract( p );
  float d1 = 9.0, d2 = 9.0; id = 0.0;
  for ( int z = -1; z <= 1; z ++ ) for ( int y = -1; y <= 1; y ++ ) for ( int x = -1; x <= 1; x ++ ) {
    vec3 g = vec3( float( x ), float( y ), float( z ) );
    vec3 r = g + lkHash3( i + g ) * 0.85 + 0.075 - f;
    float d = dot( r, r );
    if ( d < d1 ) { d2 = d1; d1 = d; id = lkHash( i + g + 3.3 ); } else if ( d < d2 ) { d2 = d; }
  }
  return vec2( sqrt( d1 ), sqrt( d2 ) );
}
float lkAA( float field ) { float w = max( fwidth( field ), 1e-4 ); return smoothstep( - w, w, field ); }
vec3 lkTriW( vec3 n ) { vec3 w = pow( abs( normalize( n ) ) + 1e-4, vec3( 4.0 ) ); return w / ( w.x + w.y + w.z ); }
float lkDots( vec2 q ) { q.x += 0.5 * mod( floor( q.y ), 2.0 ); vec2 g = fract( q ) - 0.5; return 0.25 - length( g ); }
float lkChecker( vec2 q ) { vec2 s = sin( q * 3.14159265 ); return s.x * s.y; }
float lkPanel( vec2 q ) { vec2 g = abs( fract( q ) - 0.5 ); return max( g.x, g.y ) - 0.465; }
float lkScale( vec2 q ) { q.x += 0.5 * mod( floor( q.y ), 2.0 ); vec2 g = fract( q ) - vec2( 0.5, 0.0 ); return 0.055 - abs( length( g ) - 0.52 ); }
float lkHexLine( vec2 q ) {
  const vec2 r = vec2( 1.0, 1.7320508 );
  vec2 h = r * 0.5, a = mod( q, r ) - h, b = mod( q - h, r ) - h;
  vec2 gv = dot( a, a ) < dot( b, b ) ? a : b;
  vec2 ag = abs( gv );
  return max( dot( ag, normalize( r ) ), ag.x ) - 0.45;
}
#define LK_TRI( F ) ( lkW.x * lkAA( F( lkP.yz ) ) + lkW.y * lkAA( F( lkP.xz ) ) + lkW.z * lkAA( F( lkP.xy ) ) )

float lookPattern() {
  vec3 lkP = vLookObj * uLookPatFreq;
  vec3 lkW = lkTriW( vLookObjN );
  float id;
  #if LOOK_PAT == 1
    vec3 q = lkP + ( vec3( lkFbm( lkP * 0.8 ), lkFbm( lkP * 0.8 + 5.2 ), lkFbm( lkP * 0.8 + 9.7 ) ) - 0.5 ) * 0.55;
    vec2 f = lkWorley( q, id );
    return lkAA( 0.27 + 0.16 * id - f.x );
  #elif LOOK_PAT == 2
    return LK_TRI( lkDots );
  #elif LOOK_PAT == 3
    float t = dot( lkP, uLookPatAxis ) + ( lkFbm( lkP * vec3( 0.55, 1.3, 1.3 ) ) - 0.5 ) * 1.3;
    float width = 0.09 + 0.14 * lkNoise( lkP * 1.2 + 3.1 );
    return lkAA( width - abs( fract( t ) - 0.5 ) );
  #elif LOOK_PAT == 4
    return lkAA( 0.25 - abs( fract( dot( lkP, uLookPatAxis ) ) - 0.5 ) );
  #elif LOOK_PAT == 5
    float g = clamp( ( vLookObj.z - uLookPatRange.x ) / max( 1e-4, uLookPatRange.y - uLookPatRange.x ), 0.0, 1.0 );
    return smoothstep( 0.2, 0.85, g );
  #elif LOOK_PAT == 6
    return LK_TRI( lkChecker );
  #elif LOOK_PAT == 7
    float n1 = lkFbm( lkP ), n2 = lkFbm( lkP + vec3( 7.3, 1.1, 4.4 ) );
    float m1 = lkAA( n1 - 0.53 ), m2 = lkAA( n2 - 0.5 );
    lookMask2 = vec2( m1, m2 * ( 1.0 - m1 ) );
    return m1;
  #elif LOOK_PAT == 8
    return LK_TRI( lkPanel );
  #elif LOOK_PAT == 9
    vec3 q = lkP + ( lkFbm( lkP * 1.2 ) - 0.5 ) * 0.4;
    vec2 f = lkWorley( q, id );
    return lkAA( 0.05 + 0.04 * lkNoise( lkP * 3.7 ) - ( f.y - f.x ) );
  #elif LOOK_PAT == 10
    return LK_TRI( lkScale );
  #elif LOOK_PAT == 11
    return LK_TRI( lkHexLine );
  #else
    return 0.0;
  #endif
}
`;

const FRAG_CLIP = /* glsl */`
if ( uLookReveal.z > 0.5 && vLookWorld.y > uLookReveal.x ) discard;
`;

const FRAG_COLOR = /* glsl */`
#if LOOK_PAT > 0
  lookMask = lookPattern();
  #if LOOK_PAT == 7
    diffuseColor.rgb = mix( mix( diffuseColor.rgb, uLookPatColor2, lookMask2.y ), uLookPatColor, lookMask2.x );
  #else
    diffuseColor.rgb = mix( diffuseColor.rgb, uLookPatColor, lookMask );
  #endif
#endif
`;

const FRAG_NORMAL = /* glsl */`
#ifdef LOOK_LAYER
{
  float lkS = vLookObj.z / uLookLayerPitch;
  float lkFade = 1.0 - smoothstep( 0.18, 0.5, fwidth( lkS ) );
  if ( lkFade > 0.0 ) {
    vec3 lkG = vLookLayerDir * ( cos( lkS * 6.2831853 ) * uLookLayerAmp * lkFade );
    normal = normalize( normal - ( lkG - dot( lkG, normal ) * normal ) );
  }
}
#endif
`;

const FRAG_EMISSIVE = /* glsl */`
#if LOOK_PAT > 0
  totalEmissiveRadiance += uLookPatColor * lookMask * uLookPatGlow;
#endif
if ( uLookReveal.z > 0.5 ) {
  float lkH = uLookReveal.x - vLookWorld.y;
  totalEmissiveRadiance += uLookRevealColor * ( 1.0 - smoothstep( 0.0, uLookReveal.y, lkH ) ) * 2.2;
}
`;

const FRAG_END = /* glsl */`
if ( uLookReveal.z > 0.5 && ! gl_FrontFacing ) {
  // Inside faces read as printed infill: a gyroid lattice in warm filament.
  vec3 lkQ = vLookWorld * 140.0;
  float lkG = abs( sin( lkQ.x ) * cos( lkQ.y ) + sin( lkQ.y ) * cos( lkQ.z ) + sin( lkQ.z ) * cos( lkQ.x ) );
  float lkLine = 1.0 - smoothstep( 0.18, 0.42, lkG );
  float lkHot = 1.0 - smoothstep( 0.0, uLookReveal.y * 1.6, uLookReveal.x - vLookWorld.y );
  vec3 lkC = mix( uLookInfillColor * 0.35, uLookInfillColor, lkLine ) + uLookRevealColor * lkHot * 1.5;
  gl_FragColor = vec4( lkC, 1.0 );
}
`;

// Shared function: same source -> same cache key; per-material state lives in
// material.userData.lookUniforms and the defines.
function lookOnBeforeCompile(shader, renderer) {
  const own = this.userData.lookUniforms;
  Object.assign(shader.uniforms, own);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
    .replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX_MAIN}`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`)
    .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${FRAG_CLIP}`)
    .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_COLOR}`)
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FRAG_NORMAL}`)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FRAG_EMISSIVE}`)
    .replace('#include <dithering_fragment>', `#include <dithering_fragment>\n${FRAG_END}`);
  void renderer;
}

/** Shared per-view uniforms (reveal state). */
export function createSharedUniforms() {
  return {
    uLookReveal: { value: new THREE.Vector4(1e6, 0.004, 0, 0) },
    uLookRevealColor: { value: new THREE.Color('#ff7a2e') },
    uLookInfillColor: { value: new THREE.Color('#f2b45c') },
  };
}

/**
 * Patch a lit material (Standard / Physical / Toon).
 * opts: { pattern: {kind, color, color2, freq, axis, range, glow}, layer: {amp, pitch}, shared }
 */
export function patchLookMaterial(material, { pattern = null, layer = null, shared }) {
  const kind = pattern ? PATTERN_IDS[pattern.kind] ?? 0 : 0;
  material.defines = { ...(material.defines ?? {}), LOOK_PAT: kind };
  if (layer && layer.amp > 0) material.defines.LOOK_LAYER = 1;
  material.userData.lookUniforms = {
    uLookPatColor: { value: new THREE.Color(pattern?.color ?? '#000000') },
    uLookPatColor2: { value: new THREE.Color(pattern?.color2 ?? pattern?.color ?? '#000000') },
    uLookPatFreq: { value: pattern?.freq ?? 1 },
    uLookPatAxis: { value: new THREE.Vector3(...(pattern?.axis ?? [1, 0, 0])) },
    uLookPatRange: { value: new THREE.Vector2(...(pattern?.range ?? [-0.1, 0.1])) },
    uLookPatGlow: { value: pattern?.glow ?? 0 },
    uLookLayerAmp: { value: layer?.amp ?? 0 },
    uLookLayerPitch: { value: layer?.pitch ?? 0.0025 },
    ...shared,
  };
  material.onBeforeCompile = lookOnBeforeCompile;
  return material;
}

/** Inverted-hull outline (toon ink, blueprint silhouettes). */
export function createOutlineMaterial(color = '#1d1b24', width = 0.004) {
  const material = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide, toneMapped: false });
  material.userData.outlineUniforms = { uOutline: { value: width } };
  material.onBeforeCompile = outlineOnBeforeCompile;
  return material;
}

function outlineOnBeforeCompile(shader) {
  Object.assign(shader.uniforms, this.userData.outlineUniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nuniform float uOutline;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += normalize( normal ) * uOutline;');
}
