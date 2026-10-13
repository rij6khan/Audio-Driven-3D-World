import * as THREE from 'three';
import { sampleAudioFeatures } from './audioData.js';

export const WORLD = {
  width: 180,
  length: 620,
  roadWidth: 8,
  terrainSegmentsX: 150,
  terrainSegmentsZ: 440,
};

export function roadCenterX(z, features, seed = 1) {
  const time = (z / WORLD.length) * features.duration;
  const f = sampleAudioFeatures(features, time);
  // Broad smooth turns, with extra bending as the audio becomes energetic.
  const base = 19 * Math.sin(z * 0.014 + seed * 0.71) + 9 * Math.sin(z * 0.033 + seed * 1.7);
  const audioBend = (f.pitch - 0.5) * 20 + Math.sin(z * 0.052 + seed) * f.energy * 8;
  return THREE.MathUtils.clamp(base + audioBend, -WORLD.width * 0.32, WORLD.width * 0.32);
}

export function roadElevationY(z, features, seed = 1) {
  const time = (z / WORLD.length) * features.duration;
  const energy = sampleAudioFeatures(features, time).energy;
  const broadHill = Math.sin(z * 0.018 + seed * 0.9) * (11 + energy * 6);
  const rollingHill = Math.sin(z * 0.037 + seed * 1.3) * 4.5;
  return broadHill + rollingHill;
}

export function roadHalfWidthX(z, features, seed = 1) {
  const nextZ = Math.min(WORLD.length, z + 0.5);
  const prevZ = Math.max(0, z - 0.5);
  const dx = roadCenterX(nextZ, features, seed) - roadCenterX(prevZ, features, seed);
  const dz = nextZ - prevZ || 1;
  return (WORLD.roadWidth / 2) * dz / Math.hypot(dx, dz);
}

export function createRoad({ features, seed, getTerrainHeight }) {
  const segments = 900;
  const halfWidth = WORLD.roadWidth / 2;
  const positions = [];
  const uvs = [];
  const indices = [];
  const centers = [];

  for (let i = 0; i <= segments; i++) {
    const z = (i / segments) * WORLD.length;
    const x = roadCenterX(z, features, seed);
    centers.push({ x, z });
    const nextZ = Math.min(WORLD.length, z + 0.5);
    const prevZ = Math.max(0, z - 0.5);
    const dx = roadCenterX(nextZ, features, seed) - roadCenterX(prevZ, features, seed);
    const dz = nextZ - prevZ || 1;
    const length = Math.hypot(dx, dz);
    const nx = dz / length;
    const nz = -dx / length;
    for (const side of [-1, 1]) {
      const px = x + nx * halfWidth * side;
      const pz = z + nz * halfWidth * side;
      positions.push(px, getTerrainHeight(px, pz) + 0.24, pz);
      uvs.push(side === -1 ? 0 : 1, i / 8);
    }
    if (i < segments) {
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
