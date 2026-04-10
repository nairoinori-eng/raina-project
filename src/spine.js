/**
 * Spine curve generation for scoliosis visualization.
 *
 * Models an S-type scoliosis:
 *   - Right thoracic convexity (Cobb 28°)
 *   - Left lumbar compensatory curve (Cobb 18°)
 */
import * as THREE from 'three';

// Curved spine control points (S-type scoliosis, posterior view)
const CURVED = [
  [0.00,  4.5, 0],   // C7 – top
  [0.15,  3.5, 0],   // Upper thoracic
  [0.60,  2.0, 0],   // Mid thoracic – max RIGHT convexity
  [0.40,  0.8, 0],   // Lower thoracic
  [0.00,  0.0, 0],   // Thoracolumbar junction
  [-0.35, -1.2, 0],  // Mid lumbar – max LEFT convexity
  [-0.15, -2.5, 0],  // Lower lumbar
  [0.00, -3.5, 0],   // Sacrum – bottom
];

// Straight (normal) spine – same Y spacing, X = 0
const STRAIGHT = CURVED.map(([, y, z]) => [0, y, z]);

function toVec3Array(arr) {
  return arr.map(([x, y, z]) => new THREE.Vector3(x, y, z));
}

/**
 * Create a CatmullRom spline for the spine at a given blend level.
 * @param {number} blend  0 = fully curved (scoliosis), 1 = fully straight
 */
export function createSpineCurve(blend = 0) {
  const points = CURVED.map(([cx, cy, cz], i) => {
    const [sx, sy, sz] = STRAIGHT[i];
    return new THREE.Vector3(
      THREE.MathUtils.lerp(cx, sx, blend),
      THREE.MathUtils.lerp(cy, sy, blend),
      THREE.MathUtils.lerp(cz, sz, blend),
    );
  });
  return new THREE.CatmullRomCurve3(points);
}

/**
 * Determine which spinal segment a parameter t belongs to.
 * @param {number} t  0 (top) → 1 (bottom)
 * @returns {'thoracic'|'lumbar'}
 */
export function getSegment(t) {
  return t < 0.55 ? 'thoracic' : 'lumbar';
}

/** Raw control-point arrays for external use. */
export const curvedPoints  = toVec3Array(CURVED);
export const straightPoints = toVec3Array(STRAIGHT);
