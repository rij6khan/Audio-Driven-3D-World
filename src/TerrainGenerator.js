import * as THREE from 'three';
import { sampleAudioFeatures } from './audioData.js';
import { timeAtZ } from './Timeline.js';
import { createNoise } from './noise.js';
import { WORLD, createRoadProfile, roadCenterX } from './RoadGenerator.js';
import {
  BIOMES, NIGHT, createBiomeMap, biomeGroundColor, blendBiomeColor, smoothstep,
} from './BiomeGenerator.js';

const WATER = {
  ring: 7,               // radius (world units) of the ring of ground sampled to find a basin's rim
  depth: 1.4,            // how far below the rim a basin is carved
  carveMax: 7,           // never dig deeper than this below the original ground
  roadClear: [22, 30],   // no water in the graded roadbed (see ROADBED); it fades in beyond that
  minVisible: 0.08,      // a vertex counts as "wet" once its water amount passes this
};

// Mountains are hard-coded on purpose: ridged, multi-octave noise gives sharp crests and valleys. They are flat-free at
// the roadbed's edge and get taller, steeper and more jagged the further from the road (full strength by `full`), so the
// road stays drivable while the horizon is plainly mountainous. The audio's energy only scales the height.
const MOUNTAIN_SHAPE = { start: 24, full: 90, height: 85, baseFreq: 0.011, octaves: 5, lacunarity: 2.2 };

// The horizon: the same ground carried outward from the generated terrain in every direction, on a grid whose cells grow
// with distance (so it stays cheap), until the fog swallows it.
const HORIZON = { reach: 1100, firstCell: 2.6, growth: 1.1, skirt: 12 };

// The ground is graded to meet the road: level with the road out to `flat`, then blending back to the natural ground by `far`.
const ROADBED = { flat: 6.5, far: 22 };

export function createTerrain({ features, seed, calibration = null }) {
  const noise = createNoise(seed);
  const biomeMap = createBiomeMap({ features, seed, calibration });
  const nx = WORLD.terrainSegmentsX;
  const nz = WORLD.terrainSegmentsZ;
  const cols = nx + 1;
  const rows = nz + 1;
  const vertexCount = cols * rows;

  // Where the road is at height z (remembered, since a whole row of ground points asks about the same z).
  let memoZ = NaN, memoX = 0;
  const roadXAt = z => { if (z !== memoZ) { memoZ = z; memoX = roadCenterX(z, features, seed); } return memoX; };

  // Peak height of the mountains at (x, z), `d` units from the road.
  function peaks(x, z, d, energy) {
    const reach = smoothstep(MOUNTAIN_SHAPE.start, MOUNTAIN_SHAPE.full, d);
    if (reach <= 0) return 0;
    const gain = 0.4 + 0.25 * reach; // each finer octave adds more detail the further out: the jaggedness grows with distance
    let sum = 0, amp = 0.5, freq = MOUNTAIN_SHAPE.baseFreq, weight = 1;
    for (let o = 0; o < MOUNTAIN_SHAPE.octaves; o++) {
      let n = 1 - Math.abs(noise(x * freq + o * 17.3, z * freq + o * 31.7)); // a sharp crest wherever the noise crosses zero
      n *= n * weight;                                                        // sharper still, with fine detail only on the crests
      weight = Math.min(1, Math.max(0, n * 2));
      sum += n * amp;
      amp *= gain;
      freq *= MOUNTAIN_SHAPE.lacunarity;
    }
    return reach * MOUNTAIN_SHAPE.height * (0.55 + 0.45 * energy) * sum;
  }

  // The natural ground: the audio sets the broad hills (`relief`, from FeatureShaper); noise makes them natural; and in
  // a mountain biome, peaks rise away from the road.
  function naturalHeight(x, z) {
    const audio = sampleAudioFeatures(features, timeAtZ(features, z));
    const rolling = noise(x * 0.016 + seed, z * 0.012) * (1.5 + audio.energy * 2);
    const detail = noise(x * 0.04, z * 0.035 + seed) * 0.65;
    let height = audio.relief + rolling + detail;
    if (biomeMap.hasMountains) {
      const mountainous = biomeMap.mountainAt(z);
      if (mountainous > 0) height += mountainous * peaks(x, z, Math.abs(x - roadXAt(z)), audio.energy);
    }
    return height;
  }

  // The road, and the ground graded to meet it: level with the road surface beside it, easing back to the natural
  // ground further out. Because the ground IS the road surface under and beside the road, the road can't clip into it.
  const roadProfile = createRoadProfile({ features, seed, naturalHeight });
  const near = {};
  function baseHeight(x, z) {
    const natural = naturalHeight(x, z);
    roadProfile.nearest(x, z, near);
    const grade = 1 - smoothstep(ROADBED.flat, ROADBED.far, near.d);
    return grade > 0 ? natural + (near.y - natural) * grade : natural;
  }

  /* ---- Pass 1: heights without water, then measure how rugged the terrain is ---- */
  const base = new Float32Array(vertexCount);
  const rowRoadX = new Float32Array(rows);
  for (let iz = 0; iz < rows; iz++) {
    const z = (iz / nz) * WORLD.length;
    rowRoadX[iz] = roadCenterX(z, features, seed);
    for (let ix = 0; ix < cols; ix++) base[iz * cols + ix] = baseHeight((ix / nx - 0.5) * WORLD.width, z);
  }
  const cellX = WORLD.width / nx;
  const cellZ = WORLD.length / nz;
  const slopes = new Float32Array(vertexCount);
  for (let iz = 0; iz < rows; iz++) {
    const z0 = Math.max(0, iz - 1), z1 = Math.min(nz, iz + 1);
    for (let ix = 0; ix < cols; ix++) {
      const x0 = Math.max(0, ix - 1), x1 = Math.min(nx, ix + 1);
      const sx = (base[iz * cols + x1] - base[iz * cols + x0]) / ((x1 - x0) * cellX);
      const sz = (base[z1 * cols + ix] - base[z0 * cols + ix]) / ((z1 - z0) * cellZ);
      slopes[iz * cols + ix] = Math.hypot(sx, sz);
    }
  }
  // "Flat" is judged against this song's own terrain, so every track gets some flat ground for water.
  const sortedSlopes = Float32Array.from(slopes).sort();
  const slopePct = p => sortedSlopes[Math.floor(p * (sortedSlopes.length - 1))];
  // (and never counted as flat beyond these slopes, so steep mountainsides can't hold a lake)
  const flatLo = Math.min(slopePct(0.45), 0.3), flatHi = Math.min(Math.max(slopePct(0.8), flatLo + 1e-4), 0.6);

  function slopeAt(x, z) {
    const d = 1.4;
    const sx = (baseHeight(x + d, z) - baseHeight(x - d, z)) / (2 * d);
    const sz = (baseHeight(x, z + d) - baseHeight(x, z - d)) / (2 * d);
    return Math.hypot(sx, sz);
  }

  // Lowest ground on a ring around (x, z): a basin can only fill up to its lowest rim point.
  function ringMin(x, z) {
    let min = Infinity;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      min = Math.min(min, baseHeight(x + Math.cos(a) * WATER.ring, z + Math.sin(a) * WATER.ring));
    }
    return min;
  }

  // Fills out.{T, M, water(raw field), w (final water amount), level, h (final height)}.
  function evaluate(x, z, roadX, baseH, out) {
    biomeMap.fieldsAt(x, z, roadX, out);
    let w = 0;
    if (out.water >= 0.02) {
      // (no water near the edges of the generated terrain either, where it has to match the horizon beyond)
      const edge = smoothstep(2, 22, Math.min(WORLD.width / 2 - Math.abs(x), z, WORLD.length - z));
      const clear = smoothstep(WATER.roadClear[0], WATER.roadClear[1], Math.abs(x - roadX)) * edge;
      if (clear > 0) {
        const flat = 1 - smoothstep(flatLo, flatHi, slopeAt(x, z)); // lakes sit on gentle ground
        w = out.water * clear * flat;
      }
    }
    out.w = w;
    out.level = -Infinity;
    out.h = baseH;
    if (w >= 0.01) {
      const ring = ringMin(x, z);
      out.level = Math.floor((ring - 0.15) * 2) / 2; // quantized so neighboring vertices share one flat surface
      const target = Math.max(baseH - WATER.carveMax, Math.min(baseH, ring - WATER.depth));
      out.h = baseH + (target - baseH) * w;
    }
    return out;
  }

  const scratch = {};
  function getHeight(x, z) {
    return evaluate(x, z, roadCenterX(z, features, seed), baseHeight(x, z), scratch).h;
  }

  // Everything the other generators need to know about one spot on the ground.
  function biomeAt(x, z) {
    evaluate(x, z, roadCenterX(z, features, seed), baseHeight(x, z), scratch);
    const weights = new Float32Array(BIOMES.length);
    const dominant = biomeMap.weightsAt(z, weights);
    const part = biomeMap.partAt(z);
    return { weights, dominant, T: part.T, M: part.M, water: scratch.w, level: scratch.level, height: scratch.h };
  }

  /* ---- Pass 2: final heights, water, colors ---- */
  const positions = new Float32Array(vertexCount * 3);
  const colorsBiome = new Float32Array(vertexCount * 3);
  const waterY = new Float32Array(vertexCount);
  const waterColors = new Float32Array(vertexCount * 3);
  const wet = new Uint8Array(vertexCount);

  const weights = new Float32Array(BIOMES.length);
  const ground = [0, 0, 0], accum = [0, 0, 0], waterRgb = [0, 0, 0];
  const bed = [0.1, 0.16, 0.15];
  let anyWater = false;

  for (let iz = 0; iz < rows; iz++) {
    const z = (iz / nz) * WORLD.length;
    const roadX = rowRoadX[iz];
    biomeMap.weightsAt(z, weights);   // the biome(s) here: it depends only on how far along the road we are
    const rowT = biomeMap.partAt(z).T;
    const rowNight = biomeMap.nightAt(z); // and whether it is night there (the ground takes a cool tint)
    for (let ix = 0; ix < cols; ix++) {
      const i = iz * cols + ix;
      const x = (ix / nx - 0.5) * WORLD.width;
      evaluate(x, z, roadX, base[i], scratch);
      const y = scratch.h;
      positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z;

      // Ground color: the biome's palette (blended only where one piece of a compilation hands over to the next).
      const h01 = THREE.MathUtils.clamp((y - 1) / 45, 0, 1);
      accum[0] = accum[1] = accum[2] = 0;
      for (let b = 0; b < BIOMES.length; b++) {
        const w = weights[b];
        if (w < 0.002) continue;
        biomeGroundColor(b, h01, rowT, ground);
        accum[0] += w * ground[0]; accum[1] += w * ground[1]; accum[2] += w * ground[2];
      }
      const isWet = scratch.w > WATER.minVisible && scratch.level > y;
      if (isWet) {
        // Lake beds look darker and bluer through the water.
        const k = 0.55 * Math.min(1, (scratch.level - y) / 1.2);
        for (let c = 0; c < 3; c++) accum[c] += (bed[c] - accum[c]) * k;
      }
      if (rowNight > 0) for (let c = 0; c < 3; c++) accum[c] *= 1 + (NIGHT.tint[c] - 1) * rowNight;
      const shade = 0.88 + 0.12 * (0.5 + 0.5 * noise(x * 0.11, z * 0.11));
      colorsBiome[i * 3] = accum[0] * shade; colorsBiome[i * 3 + 1] = accum[1] * shade; colorsBiome[i * 3 + 2] = accum[2] * shade;

      if (isWet) {
        wet[i] = 1;
        anyWater = true;
        waterY[i] = scratch.level;
        blendBiomeColor(weights, 'water', waterRgb);
        waterColors.set(waterRgb, i * 3);
      } else {
        waterY[i] = y - 1.2; // tucked under the ground, so the terrain hides it
      }
    }
  }

  /* ---- Meshes ---- */
  const indices = [];
  const waterIndices = [];
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const a = iz * cols + ix;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
      if (wet[a] || wet[b] || wet[c] || wet[d]) waterIndices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const colorAttribute = new THREE.Float32BufferAttribute(colorsBiome, 3);
  geometry.setAttribute('color', colorAttribute);
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 1, metalness: 0, flatShading: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.name = 'procedural-terrain';

  /* ---- The horizon: the land carried on to the fog in every direction ---- */
  // Same height function, same biome colors, so the land simply continues past the edges of what was generated.
  const farPositions = [], farColors = [], farIndices = [];
  const farColor = [0, 0, 0];
  // Grid lines from `edge` outward by HORIZON.reach, cells growing with distance (ascending order, edge not included).
  const outward = (edge, direction) => {
    const lines = [];
    let pos = 0, step = HORIZON.firstCell;
    while (pos < HORIZON.reach) { pos = Math.min(HORIZON.reach, pos + step); lines.push(edge + direction * pos); step *= HORIZON.growth; }
    return direction < 0 ? lines.reverse() : lines;
  };
  const evenly = (from, to, n) => Array.from({ length: n + 1 }, (_, k) => from + ((to - from) * k) / n);

  // One block of the horizon on the grid xs by zs. `skirtSide` is the edge that meets the fine terrain: a wall of the same
  // colors hangs below it, hiding any hairline gap where the fine and coarse grids don't line up exactly.
  function addGrid(xs, zs, skirtSide) {
    const first = farPositions.length / 3, width = xs.length;
    for (const z of zs) {
      biomeMap.weightsAt(z, weights);
      const rowT = biomeMap.partAt(z).T, rowNight = biomeMap.nightAt(z);
      for (const x of xs) {
        const y = baseHeight(x, z), h01 = THREE.MathUtils.clamp((y - 1) / 45, 0, 1);
        accum[0] = accum[1] = accum[2] = 0;
        for (let b = 0; b < BIOMES.length; b++) {
          if (weights[b] < 0.002) continue;
          biomeGroundColor(b, h01, rowT, ground);
          accum[0] += weights[b] * ground[0]; accum[1] += weights[b] * ground[1]; accum[2] += weights[b] * ground[2];
        }
        if (rowNight > 0) for (let c = 0; c < 3; c++) accum[c] *= 1 + (NIGHT.tint[c] - 1) * rowNight;
        const shade = 0.88 + 0.12 * (0.5 + 0.5 * noise(x * 0.11, z * 0.11));
        farPositions.push(x, y, z);
        farColors.push(accum[0] * shade, accum[1] * shade, accum[2] * shade);
      }
    }
    for (let j = 0; j < zs.length - 1; j++) {
      for (let i = 0; i < width - 1; i++) {
        const a = first + j * width + i, b = a + 1, c = a + width, d = c + 1;
        farIndices.push(a, c, b, b, c, d);
      }
    }
    const edge = [];
    if (skirtSide === 'xmax') for (let j = 0; j < zs.length; j++) edge.push(first + j * width + width - 1);
    if (skirtSide === 'xmin') for (let j = 0; j < zs.length; j++) edge.push(first + j * width);
    if (skirtSide === 'zmax') for (let i = 0; i < width; i++) edge.push(first + (zs.length - 1) * width + i);
    if (skirtSide === 'zmin') for (let i = 0; i < width; i++) edge.push(first + i);
    const wall = farPositions.length / 3;
    for (const v of edge) {
      farPositions.push(farPositions[v * 3], farPositions[v * 3 + 1] - HORIZON.skirt, farPositions[v * 3 + 2]);
      farColors.push(farColors[v * 3], farColors[v * 3 + 1], farColors[v * 3 + 2]);
    }
    for (let k = 0; k < edge.length - 1; k++) {
      const a = edge[k], b = edge[k + 1], c = wall + k, d = wall + k + 1;
      farIndices.push(a, c, b, b, c, d, a, b, c, b, d, c); // (both faces, so the wall shows from either side)
    }
  }

  const half = WORLD.width / 2;
  const left = outward(-half, -1), right = outward(half, 1), inner = evenly(-half, half, nx); // (the very same columns as the fine terrain, so those seams match exactly too)
  const zMain = evenly(0, WORLD.length, nz); // the very same rows as the fine terrain, so the two meet exactly along the seam
  addGrid([...left, -half], zMain, 'xmax');                                              // to the left of the generated terrain
  addGrid([half, ...right], zMain, 'xmin');                                              // to the right
  addGrid([...left, ...inner, ...right], [...outward(0, -1), 0], 'zmax');                // before the start of the road
  addGrid([...left, ...inner, ...right], [WORLD.length, ...outward(WORLD.length, 1)], 'zmin'); // beyond its end

  const farGeometry = new THREE.BufferGeometry();
  farGeometry.setAttribute('position', new THREE.Float32BufferAttribute(farPositions, 3));
  farGeometry.setAttribute('color', new THREE.Float32BufferAttribute(farColors, 3));
  farGeometry.setIndex(farIndices);
  farGeometry.computeVertexNormals();
  const far = new THREE.Mesh(farGeometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }));
  far.name = 'procedural-horizon';

  let water = null;
  if (anyWater) {
    const waterPositions = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
      waterPositions[i * 3] = positions[i * 3];
      waterPositions[i * 3 + 1] = waterY[i];
      waterPositions[i * 3 + 2] = positions[i * 3 + 2];
    }
    // Dry vertices need some color too; borrow the nearest wet color by using the terrain's own.
    for (let i = 0; i < vertexCount; i++) {
      if (!wet[i]) { waterColors[i * 3] = 0.12; waterColors[i * 3 + 1] = 0.3; waterColors[i * 3 + 2] = 0.35; }
    }
    const waterGeometry = new THREE.BufferGeometry();
    waterGeometry.setAttribute('position', new THREE.Float32BufferAttribute(waterPositions, 3));
    waterGeometry.setAttribute('color', new THREE.Float32BufferAttribute(waterColors, 3));
    waterGeometry.setIndex(waterIndices);
    waterGeometry.computeVertexNormals();
    const waterMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.18, metalness: 0.05, transparent: true, opacity: 0.82,
    });
    water = new THREE.Mesh(waterGeometry, waterMaterial);
    water.name = 'procedural-water';
  }

  return { mesh, far, water, getHeight, biomeAt, biomeMap, roadProfile };
}
