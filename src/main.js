import * as THREE from 'three';
import { makeFakeAudioFeatures, sampleAudioFeatures } from './audioData.js';
import { createTerrain } from './TerrainGenerator.js';
import { createRoad, roadCenterX, roadHalfWidthX, WORLD } from './RoadGenerator.js';
import { createScenery } from './PropGenerator.js';
import './style.css';

const app = document.querySelector('#app');
const loading = document.querySelector('#loading');
const timeLabel = document.querySelector('#time');
const energyLabel = document.querySelector('#energy');
const playButton = document.querySelector('#play-pause');
const audioDropBox = document.querySelector('#new-audio');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xb8d5d9);
scene.fog = new THREE.FogExp2(0xb8d5d9, 0.0027);
const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 1200);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
app.prepend(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xe7f4ff, 0x65714e, 2.0));
const sun = new THREE.DirectionalLight(0xffe2b5, 3.0);
sun.position.set(-70, 120, 40);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -150;
sun.shadow.camera.right = 150;
sun.shadow.camera.top = 200;
sun.shadow.camera.bottom = -100;
scene.add(sun);

// A visible sun disk helps the scene feel less like a bare technical demo.
const sunDisk = new THREE.Mesh(new THREE.SphereGeometry(8, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffedc2 }));
sunDisk.position.set(95, 95, 500);
scene.add(sunDisk);

const seed = 1;
let features;
let worldGroup;
let terrainInfo;
let roadMesh;
let scenery;
let elapsed = 0;
let playing = true;
let playerZ = 3;
let playerX = 0;
const keys = new Set();
const clock = new THREE.Clock();

function clearWorld() {
  if (!worldGroup) return;
  scene.remove(worldGroup);
  worldGroup.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      materials.forEach(m => m.dispose());
    }
  });
  worldGroup = null;
  terrainInfo = null;
  roadMesh = null;
  scenery = null;
}

function buildWorld(newFeatures) {
  loading.classList.remove('hidden');
  try {
    clearWorld();
    features = newFeatures;           // was: features = makeFakeAudioFeatures(...)
    worldGroup = new THREE.Group();
    terrainInfo = createTerrain({ features, seed });
    // ... everything else exactly as you have it ...
    worldGroup.add(terrainInfo.mesh);
    roadMesh = createRoad({ features, seed, getTerrainHeight: terrainInfo.getHeight });
    worldGroup.add(roadMesh);
    scene.add(worldGroup);
    scenery = createScenery({ scene, getTerrainHeight: terrainInfo.getHeight, features, seed });
    playerZ = 3;
    playerX = roadCenterX(playerZ, features, seed);
    elapsed = 0;
  } finally {
    loading.classList.add('hidden');  // runs even if something above throws
  }
}

// function buildWorld() {
//   loading.classList.remove('hidden');
//   clearWorld();
//   features = makeFakeAudioFeatures(seed, 48, 0.25);
//   worldGroup = new THREE.Group();
//   terrainInfo = createTerrain({ features, seed });
//   worldGroup.add(terrainInfo.mesh);
//   roadMesh = createRoad({ features, seed, getTerrainHeight: terrainInfo.getHeight });
//   worldGroup.add(roadMesh);
//   scene.add(worldGroup);
//   scenery = createScenery({ scene, getTerrainHeight: terrainInfo.getHeight, features, seed });
//   playerZ = 3;
//   playerX = roadCenterX(playerZ, features, seed);
//   elapsed = 0;
//   loading.classList.add('hidden');
// }

function updateCamera(dt) {
  const forward = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
  const sideways = (keys.has('a') || keys.has('arrowright') ? 1 : 0) - (keys.has('d') || keys.has('arrowleft') ? 1 : 0);
  if (forward !== 0) playerZ = THREE.MathUtils.clamp(playerZ + forward * dt * 32, 2, WORLD.length - 3);
  if (sideways !== 0) playerX += sideways * dt * 25;
  const centerX = roadCenterX(playerZ, features, seed);
  const roadLimit = Math.max(0, roadHalfWidthX(playerZ, features, seed) - 0.25);
  playerX = THREE.MathUtils.clamp(playerX, centerX - roadLimit, centerX + roadLimit);
  const ground = terrainInfo.getHeight(playerX, playerZ) + 2.1;
  const aheadZ = Math.min(WORLD.length, playerZ + 5);
  const aheadX = roadCenterX(aheadZ, features, seed);
  const target = new THREE.Vector3(aheadX, terrainInfo.getHeight(aheadX, aheadZ) + 2.2, aheadZ);
  const desired = new THREE.Vector3(playerX, ground + 2.0, playerZ - 9);
  camera.position.lerp(desired, 1 - Math.exp(-dt * 3.2));
  camera.lookAt(target);
}

playButton.addEventListener('click', () => {
  playing = !playing;
  playButton.textContent = playing ? 'Pause journey' : 'Resume journey';
});

audioDropBox.addEventListener('change', async () => {
  const file = audioInput.files[0];
  if (!file) return;               // user cancelled the picker
  try {
    clearWorld();
    await buildWorld(file);        // uploads, waits for features, rebuilds the scene
  } catch (err) {
    console.error(err);            // e.g. server not running, undecodable file
  }
  audioInput.value = '';           // lets the same file be chosen again
});

window.addEventListener('keydown', event => {
  const key = event.key.toLowerCase();
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(key)) event.preventDefault();
  keys.add(key);
  if (key === 'r') {
    playerZ = 3;
    playerX = roadCenterX(playerZ, features, seed);
  }
});
window.addEventListener('keyup', event => keys.delete(event.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (playing) {
    elapsed += dt;
    // Fake playback advances along the world; it does not play actual sound.
    playerZ = Math.min(WORLD.length - 3, playerZ + dt * 3.4);
  }
  updateCamera(dt);
  const time = (playerZ / WORLD.length) * features.duration;
  const current = sampleAudioFeatures(features, time);
  timeLabel.textContent = formatTime(time);
  energyLabel.textContent = current.energy.toFixed(2);
  renderer.render(scene, camera);
}
function formatTime(seconds) {
  const s = Math.floor(seconds);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

buildWorld();
playerX = roadCenterX(playerZ, features, seed);
updateCamera(1);
animate();
