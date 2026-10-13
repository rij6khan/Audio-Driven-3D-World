import * as THREE from 'three';
import { sampleAudioFeatures } from './audioData.js';
import { createNoise } from './noise.js';
import { WORLD, roadCenterX, roadElevationY } from './RoadGenerator.js';

export function createTerrain({ features, seed }) {
  const noise = createNoise(seed);
  const nx = WORLD.terrainSegmentsX;
  const nz = WORLD.terrainSegmentsZ;
  const positions = [];
  const colors = [];
  const indices = [];
  const color = new THREE.Color();

  function getHeight(x, z) {
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

  for (let iz = 0; iz <= nz; iz++) {
    const z = (iz / nz) * WORLD.length;
    for (let ix = 0; ix <= nx; ix++) {
      const x = (ix / nx - 0.5) * WORLD.width;
      const y = getHeight(x, z);
      positions.push(x, y, z);
      const n = sampleAudioFeatures(features, (z / WORLD.length) * features.duration);
      const normalized = THREE.MathUtils.clamp((y - 1) / 30, 0, 1);
      if (normalized > 0.68) color.setRGB(0.48, 0.49, 0.43); // rocky high ground
      else if (normalized > 0.42) color.setRGB(0.25, 0.39 + n.volume * 0.08, 0.20);
      else color.setRGB(0.22, 0.40 + n.volume * 0.05, 0.19);
      const shade = 0.88 + 0.12 * (0.5 + 0.5 * noise(x * 0.11, z * 0.11));
      colors.push(color.r * shade, color.g * shade, color.b * shade);
    }
  }

  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const a = iz * (nx + 1) + ix;
      const b = a + 1;
      const c = a + (nx + 1);
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 1, metalness: 0, flatShading: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.name = 'procedural-terrain';
  return { mesh, getHeight };
}

function smoothstep(edge0, edge1, x) {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
