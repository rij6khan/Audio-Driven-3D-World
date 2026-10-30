import * as THREE from 'three';
import { WORLD, roadCenterX } from './RoadGenerator.js';
import { BIOMES } from './BiomeGenerator.js';

const TREE_ATTEMPTS = 1100;
const ROCK_ATTEMPTS = 300;

// `parent` is the object everything is added to (pass the world group, so clearWorld() removes it).
// `biomeAt(x, z)` comes from createTerrain and says which biomes (and how much water) are at a spot.
export function createScenery({ scene: parent, getTerrainHeight, biomeAt, features, seed }) {
  const rng = seededRandom(seed + 717);
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

  function addPart(group, geometry, material, x, y, z, sx, sy, sz, castShadow = true) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    mesh.castShadow = castShadow;
    group.add(mesh);
    return mesh;
  }

  // Each tree shape is a few scaled primitives. `s` is the overall size, `hex` the leaf color.
  const shapes = {
    cone(x, g, z, s, hex, r) {
      addPart(trees, trunkGeometry, trunkMaterial, x, g + s * 0.25, z, s * 0.10, s * 0.55, s * 0.10);
      const crown = addPart(trees, coneGeometry, colored(hex), x, g + s * 0.82, z, s * 0.48, s * 1.05, s * 0.48);
      crown.rotation.y = r * Math.PI;
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

  for (let i = 0; i < TREE_ATTEMPTS; i++) {
    const z = 8 + rng() * (WORLD.length - 16);
    const x = (rng() - 0.5) * (WORLD.width - 12);
    if (Math.abs(x - roadCenterX(z, features, seed)) < WORLD.roadWidth * 1.6) continue;
    const info = biomeAt(x, z);
    if (info.water > 0.03) continue; // no trees in water or on the wet shore
    const biome = BIOMES[pickBiome(info.weights)];
    const spec = biome.tree;
    const roll = rng(), colorRoll = rng(), sizeRoll = rng(), spin = rng();
    if (!spec || roll > spec.density) continue;
    const size = spec.size[0] + (spec.size[1] - spec.size[0]) * sizeRoll;
    const hex = spec.colors[Math.floor(colorRoll * spec.colors.length)];
    shapes[spec.shape](x, info.height, z, size, hex, spin);
  }

  for (let i = 0; i < ROCK_ATTEMPTS; i++) {
    const z = 5 + rng() * (WORLD.length - 10);
    const x = (rng() - 0.5) * (WORLD.width - 8);
    if (Math.abs(x - roadCenterX(z, features, seed)) < WORLD.roadWidth * 1.35) continue;
    const info = biomeAt(x, z);
    if (info.water > 0.03) continue;
    const biome = BIOMES[pickBiome(info.weights)];
    const roll = rng();
    if (roll > biome.rockDensity * 0.6) continue;
    const size = 0.4 + rng() * 2.2;
    const rock = new THREE.Mesh(rockGeometry, colored(biome.rock, { flatShading: true }));
    rock.position.set(x, info.height + size * 0.28, z);
    rock.scale.set(size * (0.7 + rng() * 0.5), size * 0.45, size * (0.6 + rng() * 0.6));
    rock.rotation.set(rng(), rng() * Math.PI, rng());
    rock.castShadow = true;
    rock.receiveShadow = true;
    rocks.add(rock);
  }

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
