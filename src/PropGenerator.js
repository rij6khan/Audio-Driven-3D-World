import * as THREE from 'three';
import { WORLD, roadCenterX } from './RoadGenerator.js';

export function createScenery({ scene, getTerrainHeight, features, seed }) {
  const rng = seededRandom(seed + 717);
  const treeGeometry = new THREE.ConeGeometry(1, 1, 7);
  const trunkGeometry = new THREE.CylinderGeometry(0.16, 0.22, 1, 6);
  const rockGeometry = new THREE.DodecahedronGeometry(1, 0);
  const treeMaterials = [
    new THREE.MeshStandardMaterial({ color: 0x315d3d, roughness: 1 }),
    new THREE.MeshStandardMaterial({ color: 0x3c7047, roughness: 1 }),
    new THREE.MeshStandardMaterial({ color: 0x274c37, roughness: 1 }),
  ];
  const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x594532, roughness: 1 });
  const rockMaterial = new THREE.MeshStandardMaterial({ color: 0x777d76, roughness: 1, flatShading: true });
  const trees = new THREE.Group();
  const rocks = new THREE.Group();

  // Place props in a deterministic pattern, staying away from the road corridor.
  for (let i = 0; i < 460; i++) {
    const z = 8 + rng() * (WORLD.length - 16);
    const x = (rng() - 0.5) * (WORLD.width - 12);
    if (Math.abs(x - roadCenterX(z, features, seed)) < WORLD.roadWidth * 1.6) continue;
    const ground = getTerrainHeight(x, z);
    const size = 1.4 + rng() * 3.2;
    const trunk = new THREE.Mesh(trunkGeometry, trunkMaterial);
    trunk.position.set(x, ground + size * 0.25, z);
    trunk.scale.set(size * 0.10, size * 0.55, size * 0.10);
    trunk.castShadow = true;
    trees.add(trunk);
    const crown = new THREE.Mesh(treeGeometry, treeMaterials[Math.floor(rng() * treeMaterials.length)]);
    crown.position.set(x, ground + size * 0.82, z);
    crown.scale.set(size * 0.48, size * 1.05, size * 0.48);
    crown.rotation.y = rng() * Math.PI;
    crown.castShadow = true;
    trees.add(crown);
  }
  for (let i = 0; i < 190; i++) {
    const z = 5 + rng() * (WORLD.length - 10);
    const x = (rng() - 0.5) * (WORLD.width - 8);
    if (Math.abs(x - roadCenterX(z, features, seed)) < WORLD.roadWidth * 1.35) continue;
    const size = 0.4 + rng() * 2.2;
    const rock = new THREE.Mesh(rockGeometry, rockMaterial);
    rock.position.set(x, getTerrainHeight(x, z) + size * 0.28, z);
    rock.scale.set(size * (0.7 + rng() * 0.5), size * 0.45, size * (0.6 + rng() * 0.6));
    rock.rotation.set(rng(), rng() * Math.PI, rng());
    rock.castShadow = true;
    rock.receiveShadow = true;
    rocks.add(rock);
  }
  scene.add(trees, rocks);
  return { trees, rocks };
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
