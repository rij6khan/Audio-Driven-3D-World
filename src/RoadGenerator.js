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

// How the music steers the road. Two things in the music can: the MELODY (how high or low the sound sits) and the RHYTHM
// (the beats). Each steers one of the road's two directions, yaw (left-right) or pitch (up-down). Which steers which
// is not fixed: whichever is more prominent at that point in the file mostly steers the yaw and the other mostly the
// pitch, and in between they mix. Each also fades out where its own feature is faint, so a section with no clear beat
// has no beat-driven swerve. Speed (Timeline.js) is separate: it follows the tempo.
const ROAD = {
  yawMelody: 30,    // the road wanders this far sideways as the melody climbs and falls
  yawRhythm: 1.2,   // size of the beat-by-beat slalom
  liftMelody: 12,   // the road rises and falls this much with the melody
  liftRhythm: 0.8,  // size of the swell at each beat
  beatWidth: 3.0,   // how wide (in road units) each beat's swell or swerve is (wide enough that no bend is tighter than the road)
  // The original design, kept alongside the steering above: pitch and energy variation bend the road.
  bendPitch: 20,    // the road bends sideways as the pitch rises and falls (the original strength)
  weaveEnergy: 8,   // and weaves wider the more energetic the music is (the original strength)
  weaveRate: 0.052, // (how quickly it weaves along the road)
};

function smoothstep(a, b, x) {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// What is steering at road position z: the music's features there, and how much of the yaw (versus the pitch) the
// melody has. Both axes always get a share of both (0.2 to 0.8), so neither is ever left out.
function steering(z, features) {
  const f = sampleAudioFeatures(features, timeAtZ(features, z));
  return { f, toMelody: 0.2 + 0.6 * smoothstep(-0.25, 0.25, f.melodySay - f.rhythmSay) };
}

// One smooth bump per beat near z, each scaled by that beat's strength. With `alternate`, successive beats lean opposite ways.
function beatTerm(z, beats, alternate) {
  if (!beats) return 0;
  const reach = ROAD.beatWidth * 3;
  let lo = 0, hi = beats.z.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (beats.z[mid] < z - reach) lo = mid + 1; else hi = mid; }
  let sum = 0;
  for (let k = lo; k < beats.z.length && beats.z[k] <= z + reach; k++) {
    const d = (z - beats.z[k]) / ROAD.beatWidth;
    sum += beats.strength[k] * Math.exp(-0.5 * d * d) * (alternate && k % 2 ? -1 : 1);
  }
  return sum;
}

// Yaw: where the centerline is, sideways, at road position z.
export function roadCenterX(z, features, seed = 1) {
  const { f, toMelody } = steering(z, features);
  const melody = (f.pitch - 0.5) * ROAD.yawMelody * f.melodySay;
  const rhythm = beatTerm(z, features.beatsZ, true) * ROAD.yawRhythm * f.rhythmSay;
  const bend = (f.pitch - 0.5) * ROAD.bendPitch + Math.sin(z * ROAD.weaveRate + seed) * f.energy * ROAD.weaveEnergy;
  return THREE.MathUtils.clamp(toMelody * melody + (1 - toMelody) * rhythm + bend, -WORLD.width * 0.32, WORLD.width * 0.32);
}

// Pitch: how far the road is lifted above the ground it follows at road position z.
function roadLift(z, features) {
  const { f, toMelody } = steering(z, features);
  const melody = (f.pitch - 0.5) * ROAD.liftMelody * f.melodySay;
  const rhythm = (beatTerm(z, features.beatsZ, false) - 0.55) * ROAD.liftRhythm * f.rhythmSay; // (0.55 = the bumps' average height)
  return (1 - toMelody) * melody + toMelody * rhythm;
}

export function roadHalfWidthX(z, features, seed = 1) {
  const nextZ = Math.min(WORLD.length, z + 0.5);
  const prevZ = Math.max(0, z - 0.5);
  const dx = roadCenterX(nextZ, features, seed) - roadCenterX(prevZ, features, seed);
  const dz = nextZ - prevZ || 1;
  return (WORLD.roadWidth / 2) * dz / Math.hypot(dx, dz);
}

// The road's centerline and its surface height, sampled every PROFILE_STEP units along the road.
// The height follows the ground along the centerline (smoothed) plus the music's lift, no steeper than ROAD_MAX_SLOPE, and is the SAME
// across the whole width at each point, so the road turns only in yaw: it never banks or twists.
// The terrain is then graded to meet it (see TerrainGenerator), which is what keeps the road from clipping into
// the ground or floating above it.
const PROFILE_STEP = 0.7;
const ROAD_SMOOTH = 5;       // world units of smoothing applied to the ground height along the road
const ROAD_MAX_SLOPE = 0.7;  // steepest grade a road may have
const ROAD_ROUNDING = 2.5;   // world units of rounding applied to the road's height profile
const CAR_REACH = 2.1;       // half a car's length: the road's direction is measured over this far ahead and behind
const ROAD_LIFT = 0.2;       // the road surface sits this far above the graded ground it lies on
const SEARCH = 40;           // how many profile points either side of a position are searched for the nearest road point

export function createRoadProfile({ features, seed, naturalHeight }) {
  const n = Math.ceil(WORLD.length / PROFILE_STEP) + 1;
  const xs = new Float64Array(n), zs = new Float64Array(n), ground = new Float64Array(n), lift = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    zs[i] = Math.min(WORLD.length, i * PROFILE_STEP);
    xs[i] = roadCenterX(zs[i], features, seed);
    ground[i] = naturalHeight(xs[i], zs[i]);
    lift[i] = roadLift(zs[i], features);
  }
  // The road follows the ground (smoothed so it ignores small bumps), plus the music's lift, and is never steeper than a drivable grade.
  const smoothGround = gaussianSmooth(ground, ROAD_SMOOTH / PROFILE_STEP);
  // (The slope limit leaves sharp V-shaped kinks, which the ground, drawn on a coarser grid, would cut across and
  // cover the road; a light rounding removes them without making any grade steeper.)
  const limited = limitSlope(Float64Array.from(smoothGround, (g, i) => g + lift[i]), new Array(n).fill(PROFILE_STEP), ROAD_MAX_SLOPE);
  const ys = gaussianSmooth(limited, ROAD_ROUNDING / PROFILE_STEP);

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
  // The road at position z: the centerline point, the road surface height there (lift included, so it is exactly the
  // drawn road), and the unit direction of travel in 3D, measured over a car's length so the pitch and yaw are those of
  // a vehicle riding the road. This is what a camera needs to ride the road exactly.
  const ahead = {}, behind = {};
  // A smooth cubic curve through the road's points (not straight lines between them), so the camera's position and
  // heading have no corners and its turn rate has no steps. It passes exactly through every point of the drawn road
  // and stays within about a centimeter of it in between.
  const curve = (arr, i, t) => {
    const p0 = arr[Math.max(0, i - 1)], p1 = arr[i], p2 = arr[i + 1], p3 = arr[Math.min(n - 1, i + 2)];
    return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);
  };
  const pointAt = (z, out) => {
    const p = THREE.MathUtils.clamp(z, 0, zs[n - 1]) / PROFILE_STEP, i = Math.min(n - 2, Math.floor(p)), t = p - i;
    out.x = curve(xs, i, t);
    out.y = curve(ys, i, t) + ROAD_LIFT;
    out.z = zs[i] + (zs[i + 1] - zs[i]) * t;
    return out;
  };
  function surfaceAt(z, out = {}) {
    pointAt(z, out);
    pointAt(z + CAR_REACH, ahead);
    pointAt(z - CAR_REACH, behind);
    const dx = ahead.x - behind.x, dy = ahead.y - behind.y, dz = ahead.z - behind.z, length = Math.hypot(dx, dy, dz) || 1;
    out.tx = dx / length; out.ty = dy / length; out.tz = dz / length;
    return out;
  }
  return { n, xs, ys, zs, nearest, surfaceAt };
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
