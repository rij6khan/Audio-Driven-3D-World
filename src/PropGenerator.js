import * as THREE from 'three';
import { WORLD, roadCenterX } from './RoadGenerator.js';
import { BIOMES } from './BiomeGenerator.js';
import { sampleAudioFeatures } from './audioData.js';
import { timeAtZ } from './Timeline.js';
import { createNoise } from './noise.js';

// Placement attempts per 620 units of road (the original world length); scaled to the actual length below.
const TREE_ATTEMPTS = 1100;
const ROCK_ATTEMPTS = 300;

// `parent` is the object everything is added to (pass the world group, so clearWorld() removes it).
// `biomeAt(x, z)` comes from createTerrain and says which biomes (and how much water) are at a spot.
export function createScenery({ scene: parent, getTerrainHeight, biomeAt, biomeMap, features, seed }) {
  const rng = seededRandom(seed + 717);
  const noise = createNoise(seed + 11);
  const scale = WORLD.length / 620;
  const treeAttempts = Math.min(9000, Math.round(TREE_ATTEMPTS * scale));
  const rockAttempts = Math.min(2500, Math.round(ROCK_ATTEMPTS * scale));
  const coneGeometry = new THREE.ConeGeometry(1, 1, 7);
  const sphereGeometry = new THREE.SphereGeometry(1, 8, 6);
  const trunkGeometry = new THREE.CylinderGeometry(0.16, 0.22, 1, 6);
  const rockGeometry = new THREE.DodecahedronGeometry(1, 0);
  const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x594532, roughness: 1 });

  // One shared material per color, so hundreds of trees don't create hundreds of materials.
  const materials = new Map();
  const colored = (hex, extra = {}) => {
    const key = `${hex}:${extra.flatShading ? 'f' : 's'}`;
    if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial({ color: hex, roughness: 1, ...extra }));
    return materials.get(key);
  };

  const trees = new THREE.Group();
  const rocks = new THREE.Group();

  // Every tree is a few scaled primitives. Rather than one mesh each (thousands of draw calls on a long road),
  // parts that share a geometry and material are collected and drawn as ONE instanced mesh.
  const batches = new Map(); // geometry -> material -> { group, items }
  function addPart(group, geometry, material, x, y, z, sx, sy, sz, rotation = [0, 0, 0]) {
    if (!batches.has(geometry)) batches.set(geometry, new Map());
    const byMaterial = batches.get(geometry);
    if (!byMaterial.has(material)) byMaterial.set(material, { group, items: [] });
    byMaterial.get(material).items.push({ x, y, z, sx, sy, sz, rotation });
  }
  function buildInstances() {
    const dummy = new THREE.Object3D();
    for (const [geometry, byMaterial] of batches) {
      for (const [material, { group, items }] of byMaterial) {
        const mesh = new THREE.InstancedMesh(geometry, material, items.length);
        items.forEach((it, i) => {
          dummy.position.set(it.x, it.y, it.z);
          dummy.rotation.set(it.rotation[0], it.rotation[1], it.rotation[2]);
          dummy.scale.set(it.sx, it.sy, it.sz);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.castShadow = true;
        mesh.receiveShadow = group === rocks;
        mesh.frustumCulled = false; // the instances span the whole road, so a single bounding sphere would be wrong
        group.add(mesh);
      }
    }
  }

  // Each tree shape is a few scaled primitives. `s` is the overall size, `hex` the leaf color.
  const shapes = {
    cone(x, g, z, s, hex, r) {
      addPart(trees, trunkGeometry, trunkMaterial, x, g + s * 0.25, z, s * 0.10, s * 0.55, s * 0.10);
      addPart(trees, coneGeometry, colored(hex), x, g + s * 0.82, z, s * 0.48, s * 1.05, s * 0.48, [0, r * Math.PI, 0]);
    },
    round(x, g, z, s, hex) {
      addPart(trees, trunkGeometry, trunkMaterial, x, g + s * 0.3, z, s * 0.10, s * 0.65, s * 0.10);
      addPart(trees, sphereGeometry, colored(hex), x, g + s * 0.95, z, s * 0.55, s * 0.5, s * 0.55);
    },
    umbrella(x, g, z, s, hex) {
      addPart(trees, trunkGeometry, trunkMaterial, x, g + s * 0.45, z, s * 0.07, s * 0.9, s * 0.07);
      addPart(trees, sphereGeometry, colored(hex), x, g + s * 0.95, z, s * 0.75, s * 0.18, s * 0.75);
    },
    cactus(x, g, z, s, hex) {
      const m = colored(hex);
      addPart(trees, trunkGeometry, m, x, g + s * 0.45, z, s * 0.12, s * 0.9, s * 0.12);
      addPart(trees, trunkGeometry, m, x + s * 0.2, g + s * 0.55, z, s * 0.07, s * 0.35, s * 0.07);
    },
    reed(x, g, z, s, hex, r) {
      const m = colored(hex);
      for (let k = 0; k < 4; k++) {
        const a = r * 6.28 + k * 1.7, off = s * 0.16 * (0.5 + (k % 2));
        const h = s * (0.85 + 0.12 * k);
        addPart(trees, trunkGeometry, m, x + Math.cos(a) * off, g + h * 0.5, z + Math.sin(a) * off, s * 0.035, h, s * 0.035);
      }
    },
    shrub(x, g, z, s, hex) {
      addPart(trees, sphereGeometry, colored(hex), x, g + s * 0.12, z, s * 0.45, s * 0.28, s * 0.45);
    },
  };

  // Pick a biome at random in proportion to its weight, so borders blend instead of cutting.
  function pickBiome(weights) {
    let r = rng();
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return weights.length - 1;
  }

  // How busy the music is at road position z (0..1) sets three things about the scenery there:
  //   quantity     busier music, more plants and rocks
  //   distribution calm music spreads them evenly; busy music gathers them into clumps and leaves gaps
  //   variety      busy music uses more of a biome's colors and a wider range of sizes
  const busyAt = z => sampleAudioFeatures(features, timeAtZ(features, z)).complexity;
  const crowdAt = (x, z, busy) => {
    const clump = 0.5 + 0.5 * noise(x * 0.045, z * 0.045);
    return (0.35 + 0.95 * busy) * (1 + (2 * clump - 1) * 0.8 * busy);
  };

  for (let i = 0; i < treeAttempts; i++) {
    const z = 8 + rng() * (WORLD.length - 16);
    const x = (rng() - 0.5) * (WORLD.width - 12);
    if (Math.abs(x - roadCenterX(z, features, seed)) < WORLD.roadWidth * 1.6) continue;
    const info = biomeAt(x, z);
    if (info.water > 0.03) continue; // no trees in water or on the wet shore
    const biome = BIOMES[pickBiome(info.weights)];
    const spec = biome.tree;
    if (spec.maxHeight && info.height > spec.maxHeight) continue; // no trees above the tree line
    const roll = rng(), colorRoll = rng(), sizeRoll = rng(), spin = rng();
    const busy = busyAt(z);
    if (!spec || roll > spec.density * (spec.dense ? Math.max(1, crowdAt(x, z, busy)) : crowdAt(x, z, busy))) continue;
    const size = (spec.size[0] + spec.size[1]) / 2 + (sizeRoll - 0.5) * (spec.size[1] - spec.size[0]) * (0.35 + 0.65 * busy);
    const hex = spec.colors[Math.floor(colorRoll * Math.max(1, Math.ceil(spec.colors.length * (0.4 + 0.6 * busy))))];
    shapes[spec.shape](x, info.height, z, size, hex, spin);
  }

  // A rainforest is so thick the sky is mostly hidden. On purpose, it gets many times the trees of any other biome, all of
  // them tall, plus a leafy ceiling over the road, so little light gets through (see `dense` in BiomeGenerator).
  const denseIndex = BIOMES.findIndex(b => b.tree.dense);
  if (biomeMap && biomeMap.parts.some(part => BIOMES[part.biome].tree.dense)) {
    const attempts = Math.min(16000, 5 * treeAttempts);
    for (let i = 0; i < attempts; i++) {
      const z = 8 + rng() * (WORLD.length - 16);
      const x = (rng() - 0.5) * (WORLD.width - 12);
      if (Math.abs(x - roadCenterX(z, features, seed)) < WORLD.roadWidth * 1.6) continue;
      const info = biomeAt(x, z);
      const spec = BIOMES[info.dominant].tree;
      if (!spec.dense || info.water > 0.03) continue;
      const size = spec.size[0] + (spec.size[1] - spec.size[0]) * rng();
      shapes[spec.shape](x, info.height, z, size, spec.colors[Math.floor(rng() * spec.colors.length)], rng());
    }
    const leaf = colored(BIOMES[denseIndex].tree.colors[2]);
    for (let z = 6; z < WORLD.length - 6; z += 8) {
      const roadX = roadCenterX(z, features, seed);
      const info = biomeAt(roadX, z);
      if (!BIOMES[info.dominant].tree.dense || rng() > 0.92) continue;
      // wide, flat clumps of leaves very high above the road, at the tops of the tall trees, overlapping into a canopy
      addPart(trees, sphereGeometry, leaf, roadX + (rng() - 0.5) * 12, info.height + 30 + rng() * 10, z + (rng() - 0.5) * 3,
        14 + rng() * 6, 3 + rng() * 1.5, 12 + rng() * 5);
    }
  }

  for (let i = 0; i < rockAttempts; i++) {
    const z = 5 + rng() * (WORLD.length - 10);
    const x = (rng() - 0.5) * (WORLD.width - 8);
    if (Math.abs(x - roadCenterX(z, features, seed)) < WORLD.roadWidth * 1.35) continue;
    const info = biomeAt(x, z);
    if (info.water > 0.03) continue;
    const biome = BIOMES[pickBiome(info.weights)];
    const roll = rng();
    if (roll > biome.rockDensity * 0.6 * crowdAt(x, z, busyAt(z))) continue;
    const size = 0.4 + rng() * 2.2;
    const sx = size * (0.7 + rng() * 0.5), sz = size * (0.6 + rng() * 0.6);
    addPart(rocks, rockGeometry, colored(biome.rock, { flatShading: true }), x, info.height + size * 0.28, z,
      sx, size * 0.45, sz, [rng(), rng() * Math.PI, rng()]);
  }

  buildInstances();
  parent.add(trees, rocks);
  return { trees, rocks };
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
