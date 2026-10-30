import * as THREE from 'three';
import { sampleAudioFeatures } from './audioData.js';
import { createNoise } from './noise.js';
import { WORLD, roadCenterX, roadElevationY } from './RoadGenerator.js';
import {
  BIOMES, createBiomeMap, classify, biomeGroundColor, blendBiomeColor, smoothstep,
} from './BiomeGenerator.js';

const WATER = {
  ring: 7,               // radius (world units) of the ring of ground sampled to find a basin's rim
  depth: 1.4,            // how far below the rim a basin is carved
  carveMax: 7,           // never dig deeper than this below the original ground
  roadClear: [11, 20],   // no water within 11 units of the road's center, full strength by 20
  minVisible: 0.08,      // a vertex counts as "wet" once its water amount passes this
};

export const VIEW_MODES = ['biome', 'heat', 'moisture'];

export function createTerrain({ features, seed }) {
  const noise = createNoise(seed);
  const biomeMap = createBiomeMap({ features, seed });
  const nx = WORLD.terrainSegmentsX;
  const nz = WORLD.terrainSegmentsZ;
  const cols = nx + 1;
  const rows = nz + 1;
  const vertexCount = cols * rows;

  // The original terrain formula, before any water is carved into it.
  function baseHeight(x, z) {
    const time = THREE.MathUtils.clamp(z / WORLD.length, 0, 1) * features.duration;
    const audio = sampleAudioFeatures(features, time);
    // Audio envelope creates the broad hills; multi-scale noise makes them natural.
    const broadHeight = 3 + Math.pow(audio.volume, 1.55) * 23;
    const rolling = noise(x * 0.016 + seed, z * 0.012) * (1.5 + audio.energy * 2);
    const detail = noise(x * 0.04, z * 0.035 + seed) * 0.65;
    let height = broadHeight + rolling + detail;

    // Carve a shallow, wide valley under the road so it remains connected to the terrain.
    const roadX = roadCenterX(z, features, seed);
    const distance = Math.abs(x - roadX);
    height += roadElevationY(z, features, seed) * (1 - smoothstep(5, 26, distance));
    const valley = 1 - smoothstep(7, 25, distance);
    height -= valley * Math.max(0, height - 1.5) * 0.72;
    return height;
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
  // "Rugged" and "flat" are judged against this song's own terrain, so every track gets some of each.
  const sortedSlopes = Float32Array.from(slopes).sort();
  const slopePct = p => sortedSlopes[Math.floor(p * (sortedSlopes.length - 1))];
  const ruggedLo = slopePct(0.75), ruggedHi = Math.max(slopePct(0.97), ruggedLo + 1e-4);
  const flatLo = slopePct(0.45), flatHi = Math.max(slopePct(0.8), flatLo + 1e-4);

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
      const clear = smoothstep(WATER.roadClear[0], WATER.roadClear[1], Math.abs(x - roadX));
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
    const relief = smoothstep(ruggedLo, ruggedHi, slopeAt(x, z));
    const weights = new Float32Array(BIOMES.length);
    const dominant = classify(scratch.T, scratch.M, relief, weights, biomeMap.anchors);
    return { weights, dominant, T: scratch.T, M: scratch.M, relief, water: scratch.w, level: scratch.level, height: scratch.h };
  }

  /* ---- Pass 2: final heights, water, colors ---- */
  const positions = new Float32Array(vertexCount * 3);
  const colorsBiome = new Float32Array(vertexCount * 3);
  const colorsHeat = new Float32Array(vertexCount * 3);
  const colorsMoisture = new Float32Array(vertexCount * 3);
  const waterY = new Float32Array(vertexCount);
  const waterColors = new Float32Array(vertexCount * 3);
  const wet = new Uint8Array(vertexCount);

  const weights = new Float32Array(BIOMES.length);
  const ground = [0, 0, 0], accum = [0, 0, 0], waterRgb = [0, 0, 0], thermal = [0, 0, 0];
  const bed = [0.1, 0.16, 0.15];
  let anyWater = false;

  for (let iz = 0; iz < rows; iz++) {
    const z = (iz / nz) * WORLD.length;
    const roadX = rowRoadX[iz];
    for (let ix = 0; ix < cols; ix++) {
      const i = iz * cols + ix;
      const x = (ix / nx - 0.5) * WORLD.width;
      evaluate(x, z, roadX, base[i], scratch);
      const y = scratch.h;
      positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z;

      const relief = smoothstep(ruggedLo, ruggedHi, slopes[i]);
      classify(scratch.T, scratch.M, relief, weights, biomeMap.anchors);

      // Ground color: blend every biome's palette by its weight.
      const h01 = THREE.MathUtils.clamp((y - 1) / 30, 0, 1);
      accum[0] = accum[1] = accum[2] = 0;
      for (let b = 0; b < BIOMES.length; b++) {
        const w = weights[b];
        if (w < 0.002) continue;
        biomeGroundColor(b, h01, scratch.T, ground);
        accum[0] += w * ground[0]; accum[1] += w * ground[1]; accum[2] += w * ground[2];
      }
      const isWet = scratch.w > WATER.minVisible && scratch.level > y;
      if (isWet) {
        // Lake beds look darker and bluer through the water.
        const k = 0.55 * Math.min(1, (scratch.level - y) / 1.2);
        for (let c = 0; c < 3; c++) accum[c] += (bed[c] - accum[c]) * k;
      }
      const shade = 0.88 + 0.12 * (0.5 + 0.5 * noise(x * 0.11, z * 0.11));
      colorsBiome[i * 3] = accum[0] * shade; colorsBiome[i * 3 + 1] = accum[1] * shade; colorsBiome[i * 3 + 2] = accum[2] * shade;

      // Debug views: the raw temperature and moisture fields as heat maps.
      thermalColor(scratch.T, thermal);
      colorsHeat.set(thermal, i * 3);
      moistureColor(scratch.M, thermal);
      colorsMoisture.set(thermal, i * 3);

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

  // Switch the terrain between the real biome colors and the raw temperature / moisture maps.
  const views = { biome: colorsBiome, heat: colorsHeat, moisture: colorsMoisture };
  function setView(mode) {
    const source = views[mode] ?? colorsBiome;
    colorAttribute.array.set(source);
    colorAttribute.needsUpdate = true;
  }

  return { mesh, water, getHeight, biomeAt, setView, biomeMap };
}

// Blue (cold) -> cyan -> yellow -> red (hot).
function thermalColor(t, out) {
  const stops = [[0, [0.05, 0.1, 0.5]], [0.33, [0.05, 0.6, 0.75]], [0.66, [0.9, 0.85, 0.2]], [1, [0.85, 0.15, 0.08]]];
  return gradient(stops, t, out);
}
// Dry tan -> green -> wet blue.
function moistureColor(t, out) {
  const stops = [[0, [0.55, 0.42, 0.2]], [0.5, [0.2, 0.5, 0.2]], [1, [0.05, 0.25, 0.75]]];
  return gradient(stops, t, out);
}
function gradient(stops, t, out) {
  t = THREE.MathUtils.clamp(t, 0, 1);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
      const k = (t - t0) / (t1 - t0);
      for (let c = 0; c < 3; c++) out[c] = c0[c] + (c1[c] - c0[c]) * k;
      return out;
    }
  }
  const last = stops[stops.length - 1][1];
  for (let c = 0; c < 3; c++) out[c] = last[c];
  return out;
}
