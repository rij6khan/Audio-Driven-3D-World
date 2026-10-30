import * as THREE from 'three';
import { sampleAudioFeatures } from './audioData.js';
import { timeAtZ } from './Timeline.js';
import { limitSlope } from './FeatureShaper.js';

export const WORLD = {
  width: 180,
  length: 620,
  roadWidth: 8,
  terrainSegmentsX: 150,
  terrainSegmentsZ: 440,
};

// The world's length follows the song (see Timeline.js), so it is set each time a world is built.
const CELL_Z = 1.4;     // ground resolution along the road
const MAX_ROWS = 3600;  // cap, so very long songs don't make an enormous mesh
export function setWorldLength(length) {
  WORLD.length = length;
  WORLD.terrainSegmentsZ = Math.min(MAX_ROWS, Math.ceil(length / CELL_Z));
}

export function roadCenterX(z, features, seed = 1) {
  const time = timeAtZ(features, z);
  const f = sampleAudioFeatures(features, time);
  // Broad smooth turns, with extra bending as the audio becomes energetic.
  const base = 19 * Math.sin(z * 0.014 + seed * 0.71) + 9 * Math.sin(z * 0.033 + seed * 1.7);
  const audioBend = (f.pitch - 0.5) * 20 + Math.sin(z * 0.052 + seed) * f.energy * 8;
  return THREE.MathUtils.clamp(base + audioBend, -WORLD.width * 0.32, WORLD.width * 0.32);
}

export function roadHalfWidthX(z, features, seed = 1) {
  const nextZ = Math.min(WORLD.length, z + 0.5);
  const prevZ = Math.max(0, z - 0.5);
  const dx = roadCenterX(nextZ, features, seed) - roadCenterX(prevZ, features, seed);
  const dz = nextZ - prevZ || 1;
  return (WORLD.roadWidth / 2) * dz / Math.hypot(dx, dz);
}

// The road's centerline and its surface height, sampled every PROFILE_STEP units along the road.
// The height follows the ground along the centerline (smoothed, and no steeper than ROAD_MAX_SLOPE) and is the SAME
// across the whole width at each point, so the road turns only in yaw: it never banks or twists.
// The terrain is then graded to meet it (see TerrainGenerator), which is what keeps the road from clipping into
// the ground or floating above it.
const PROFILE_STEP = 0.7;
const ROAD_SMOOTH = 5;       // world units of smoothing applied to the ground height along the road
const ROAD_MAX_SLOPE = 0.45; // steepest grade a road may have
const ROAD_LIFT = 0.12;      // the road surface sits this far above the graded ground it lies on
const SEARCH = 40;           // how many profile points either side of a position are searched for the nearest road point

export function createRoadProfile({ features, seed, naturalHeight }) {
  const n = Math.ceil(WORLD.length / PROFILE_STEP) + 1;
  const xs = new Float64Array(n), zs = new Float64Array(n), ground = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    zs[i] = Math.min(WORLD.length, i * PROFILE_STEP);
    xs[i] = roadCenterX(zs[i], features, seed);
    ground[i] = naturalHeight(xs[i], zs[i]);
  }
  const ys = limitSlope(gaussianSmooth(ground, ROAD_SMOOTH / PROFILE_STEP), new Array(n).fill(PROFILE_STEP), ROAD_MAX_SLOPE);

  // Closest point of the road to (x, z): its distance, and the road surface height there.
  function nearest(x, z, out = {}) {
    const guess = THREE.MathUtils.clamp(Math.round(z / PROFILE_STEP), 0, n - 1);
    if (Math.abs(x - xs[guess]) > 62) { out.d = Infinity; out.y = 0; return out; } // far from the road: skip the search
    let best = Infinity, bestY = 0;
    for (let i = Math.max(0, guess - SEARCH); i < Math.min(n - 1, guess + SEARCH); i++) {
      const dx = xs[i + 1] - xs[i], dz = zs[i + 1] - zs[i];
      const t = THREE.MathUtils.clamp(((x - xs[i]) * dx + (z - zs[i]) * dz) / (dx * dx + dz * dz), 0, 1);
      const px = x - (xs[i] + dx * t), pz = z - (zs[i] + dz * t);
      const d2 = px * px + pz * pz;
      if (d2 < best) { best = d2; bestY = ys[i] + (ys[i + 1] - ys[i]) * t; }
    }
    out.d = Math.sqrt(best);
    out.y = bestY;
    return out;
  }
  return { n, xs, ys, zs, nearest };
}

export function createRoad({ profile }) {
  const { n, xs, ys, zs } = profile;
  const halfWidth = WORLD.roadWidth / 2;
  const positions = [];
  const uvs = [];
  const indices = [];
  const centers = [];
  for (let i = 0; i < n; i++) {
    centers.push({ x: xs[i], z: zs[i] });
    const prev = Math.max(0, i - 1), next = Math.min(n - 1, i + 1);
    const dx = xs[next] - xs[prev], dz = zs[next] - zs[prev];
    const length = Math.hypot(dx, dz) || 1;
    const nx = dz / length, nz = -dx / length;            // sideways direction, in the ground plane only
    const y = ys[i] + ROAD_LIFT;                           // one height for both edges: no banking
    for (const side of [-1, 1]) {
      positions.push(xs[i] + nx * halfWidth * side, y, zs[i] + nz * halfWidth * side);
      uvs.push(side === -1 ? 0 : 1, i / 11);
    }
    if (i < n - 1) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color: 0x333b40, roughness: 0.95, metalness: 0.02, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.name = 'procedural-road';
  mesh.userData.centers = centers;
  return mesh;
}

function gaussianSmooth(values, sigma) {
  const radius = Math.ceil(3 * sigma), kernel = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) { const w = Math.exp(-0.5 * (i / sigma) ** 2); kernel.push(w); sum += w; }
  const last = values.length - 1;
  return Float64Array.from(values, (_, i) => {
    let acc = 0;
    for (let j = -radius; j <= radius; j++) acc += kernel[j + radius] * values[Math.min(last, Math.max(0, i + j))];
    return acc / sum;
  });
}
