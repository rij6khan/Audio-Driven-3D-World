import * as THREE from 'three';
import { makeFakeAudioFeatures, sampleAudioFeatures, makeAudioFeatures } from './audioData.js';
import { createTerrain, VIEW_MODES } from './TerrainGenerator.js';
import { createRoad, roadCenterX, roadHalfWidthX, WORLD } from './RoadGenerator.js';
import { createScenery } from './PropGenerator.js';
import { BIOMES, blendBiomeColor } from './BiomeGenerator.js';
import './style.css';

const app = document.querySelector('#app');
const loading = document.querySelector('#loading');
const timeLabel = document.querySelector('#time');
const energyLabel = document.querySelector('#energy');
const biomeLabel = document.querySelector('#biome'); // optional: add a #biome element to the HUD to show it
const playButton = document.querySelector('#play-pause');
const audioDropBox = document.querySelector('#new-audio');
const loadingDefaultText = loading.textContent;

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
let viewIndex = 0; // 0 = biome colors, then the temperature and moisture debug maps (press H)
let shownLabel = '';
const keys = new Set();
const clock = new THREE.Clock();
const fogTarget = new THREE.Color();
const fogRgb = [0, 0, 0];

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

// With no argument it builds the demo world from fake data; with a features object it builds from that.
// The new world is fully built BEFORE the old one is removed, so if generation throws the old world stays.
function buildWorld(newFeatures = makeFakeAudioFeatures(seed, 48, 0.25)) {
  loading.classList.remove('hidden');
  try {
    const nextGroup = new THREE.Group();
    const nextTerrain = createTerrain({ features: newFeatures, seed });
    nextGroup.add(nextTerrain.mesh);
    if (nextTerrain.water) nextGroup.add(nextTerrain.water);
    const nextRoad = createRoad({ features: newFeatures, seed, getTerrainHeight: nextTerrain.getHeight });
    nextGroup.add(nextRoad);
    // Scenery goes into the world group (not the scene) so clearWorld() removes it along with the terrain.
    const nextScenery = createScenery({
      scene: nextGroup, getTerrainHeight: nextTerrain.getHeight, biomeAt: nextTerrain.biomeAt, features: newFeatures, seed,
    });

    clearWorld();
    features = newFeatures;
    worldGroup = nextGroup;
    terrainInfo = nextTerrain;
    roadMesh = nextRoad;
    scenery = nextScenery;
    scene.add(worldGroup);
    terrainInfo.setView(VIEW_MODES[viewIndex]);
    console.info('[biomes] temperature/moisture correlation:', terrainInfo.biomeMap.diagnostics.correlationTM.toFixed(2),
      '| anchors adapted:', terrainInfo.biomeMap.diagnostics.anchorsAdapted);
    playerZ = 3;
    playerX = roadCenterX(playerZ, features, seed);
    elapsed = 0;
  } finally {
    loading.classList.add('hidden');
  }
}

/* ------------------------------ audio upload ------------------------------ */

function setLoading(text) {
  loading.textContent = text;
  loading.classList.remove('hidden');
}
const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

async function handleAudioFile(file) {
  if (!file) return;
  setLoading('Analyzing audio…');
  try {
    const newFeatures = await makeAudioFeatures(file); // slow part: decode + spectrum
    setLoading(loadingDefaultText);
    await nextFrame();                                  // let the overlay paint before the heavy build
    buildWorld(newFeatures);
  } catch (err) {
    console.error(err);                                 // the old world stays on screen
    setLoading(`Couldn't use that file: ${err.message}`);
    setTimeout(() => {
      loading.textContent = loadingDefaultText;
      loading.classList.add('hidden');
    }, 3500);
  }
}

if (audioDropBox) {
  // 'change' bubbles, so this works whether #new-audio is the file input itself or a wrapper around it.
  audioDropBox.addEventListener('change', event => {
    const input = event.target;
    handleAudioFile(input.files?.[0]).finally(() => { input.value = ''; }); // lets the same file be picked again
  });
} else {
  console.warn('No element with id "new-audio" found: audio upload is disabled.');
}

/* ---------------------------- atmosphere & camera ---------------------------- */

// Fog and sky drift toward the fog color of whichever biome is just ahead of the player.
function updateAtmosphere(dt) {
  const info = terrainInfo.biomeAt(playerX, Math.min(WORLD.length, playerZ + 12));
  blendBiomeColor(info.weights, 'fog', fogRgb);
  fogTarget.setRGB(fogRgb[0], fogRgb[1], fogRgb[2]);
  const k = 1 - Math.exp(-dt * 1.5);
  scene.fog.color.lerp(fogTarget, k);
  scene.background.lerp(fogTarget, k);

  if (biomeLabel) {
    const label = viewIndex === 0 ? BIOMES[info.dominant].name : `${VIEW_MODES[viewIndex]} map`;
    if (label !== shownLabel) {
      shownLabel = label;
      biomeLabel.textContent = label;
    }
  }
}

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
window.addEventListener('keydown', event => {
  const key = event.key.toLowerCase();
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(key)) event.preventDefault();
  keys.add(key);
  if (key === 'r') {
    playerZ = 3;
    playerX = roadCenterX(playerZ, features, seed);
  }
  if (key === 'h' && terrainInfo) {
    // Cycle: biome colors -> temperature map -> moisture map.
    viewIndex = (viewIndex + 1) % VIEW_MODES.length;
    terrainInfo.setView(VIEW_MODES[viewIndex]);
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
  updateAtmosphere(dt);
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
