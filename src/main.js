import * as THREE from 'three';
import { makeFakeAudioFeatures, sampleAudioFeatures, analyzeAudioFile, isSilentAt } from './audioData.js';
import { createTerrain } from './TerrainGenerator.js';
import { createRoad, roadCenterX, roadHalfWidthX, setWorldLength, WORLD } from './RoadGenerator.js';
import { createScenery } from './PropGenerator.js';
import { BIOMES, MOUNTAIN, blendBiomeColor, blendBiomeWeather, biomeCss } from './BiomeGenerator.js';
import { createWeather } from './Weather.js';
import { prepareFeatures } from './FeatureShaper.js';
import './style.css';

const app = document.querySelector('#app');
const loading = document.querySelector('#loading');
const timeLabel = document.querySelector('#time');
const energyLabel = document.querySelector('#energy');
const playButton = document.querySelector('#play-pause');
const audioDropBox = document.querySelector('#audio-file');
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
scene.add(sun, sun.target);

// A visible sun disk helps the scene feel less like a bare technical demo.
const sunDisk = new THREE.Mesh(new THREE.SphereGeometry(8, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffedc2 }));
sunDisk.position.set(95, 95, 500);
scene.add(sunDisk);

const weather = createWeather(scene);

// The biome label, upper right.
const badge = document.createElement('div');
badge.id = 'biome-badge';
badge.setAttribute('role', 'status');
const badgeLabel = document.createElement('span');
badgeLabel.className = 'badge-label';
const badgeName = document.createElement('strong');
badge.appendChild(badgeLabel);
badge.appendChild(badgeName);
document.body.appendChild(badge);
function setBadge(label, name, color) {
  if (badgeName.textContent === name) return;
  badgeLabel.textContent = label;
  badgeName.textContent = name;
  badge.style.setProperty('--biome-color', color);
}

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
let shownBiome = -1;  // the biome named in the badge (it only changes once another clearly takes over)
const BASE_FOG = 0.0027, BASE_SUN = 3.0;
const weatherNow = {};
const keys = new Set();
const clock = new THREE.Clock();
const fogTarget = new THREE.Color();
const fogRgb = [0, 0, 0];

function clearWorld() {
  if (!worldGroup) return;
  scene.remove(worldGroup);
  worldGroup.traverse(obj => {
    if (obj.isInstancedMesh) obj.dispose();
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
  const previousLength = WORLD.length;
  try {
    const worldFeatures = prepareFeatures(newFeatures);      // adds the timeline; shapes real audio's terrain
    setWorldLength(worldFeatures.timeline.length);           // the road is as long as the song takes to drive
    const nextGroup = new THREE.Group();
    const nextTerrain = createTerrain({ features: worldFeatures, seed });
    nextGroup.add(nextTerrain.mesh);
    if (nextTerrain.water) nextGroup.add(nextTerrain.water);
    const nextRoad = createRoad({ profile: nextTerrain.roadProfile });
    nextGroup.add(nextRoad);
    // Scenery goes into the world group (not the scene) so clearWorld() removes it along with the terrain.
    const nextScenery = createScenery({
      scene: nextGroup, getTerrainHeight: nextTerrain.getHeight, biomeAt: nextTerrain.biomeAt, features: worldFeatures, seed,
    });

    clearWorld();
    features = worldFeatures;
    worldGroup = nextGroup;
    terrainInfo = nextTerrain;
    roadMesh = nextRoad;
    scenery = nextScenery;
    scene.add(worldGroup);
    console.info('[biome]', terrainInfo.biomeMap.parts.map(p => `${BIOMES[p.biome].name} (temperature ${p.T.toFixed(2)}, moisture ${p.M.toFixed(2)}, hill range ${p.spread.toFixed(1)}, ${p.from.toFixed(0)}-${p.to.toFixed(0)} s)`).join(' | '));
    playerZ = 3;
    playerX = roadCenterX(playerZ, features, seed);
    elapsed = 0;
    shownBiome = -1;
  } catch (err) {
    setWorldLength(previousLength); // the old world stays on screen, so keep its length
    throw err;
  } finally {
    loading.classList.add('hidden');
  }
}

/* --------------------------------- sound --------------------------------- */

const DRIFT_LIMIT = 0.35;     // seconds the sound may drift from the playhead before it is re-synced
const SILENCE_WINDOW = 1;     // seconds of upcoming audio checked when the user turns sound on

let audioBuffer = null;       // the submitted file, decoded. null until a file is submitted
let soundOn = false;
let audioContext = null;
let masterGain = null;
let source = null;            // the currently playing AudioBufferSourceNode (they are single-use)
let sourceGain = null;
let sourceStartedAt = 0;      // audioContext time when `source` started
let sourceOffset = 0;         // position in the file (seconds) where `source` started
let scrubbing = false;        // true while the user holds forward/back, which moves the playhead far faster than real time

// Find the button and message line in index.html if they exist; otherwise create them.
const soundButton = document.querySelector('#sound-toggle') ?? (() => {
  const b = document.createElement('button');
  b.id = 'sound-toggle';
  b.type = 'button';
  b.className = 'secondary';
  playButton.insertAdjacentElement('afterend', b);
  return b;
})();
const caption = document.querySelector('#caption') ?? (() => {
  const p = document.createElement('p');
  p.id = 'caption';
  p.setAttribute('role', 'status');
  document.body.appendChild(p);
  return p;
})();

let captionTimer = null;
function showCaption(text, ms = 2800) {
  caption.textContent = text;
  caption.classList.add('visible');
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => caption.classList.remove('visible'), ms);
}

function updateSoundButton() {
  soundButton.textContent = soundOn ? 'Sound on' : 'Sound off';
  soundButton.setAttribute('aria-pressed', String(soundOn));
  // Locked looks disabled but still receives clicks, so we can explain *why* it is locked.
  soundButton.classList.toggle('locked', !audioBuffer);
  soundButton.setAttribute('aria-disabled', String(!audioBuffer));
}

// Where the user is on the road, as a time in the song.
function worldTime() { return features.timeline.timeAt(playerZ); }

function ensureAudioContext() {
  if (!audioContext) {
    audioContext = new AudioContext();
    masterGain = audioContext.createGain();
    masterGain.connect(audioContext.destination);
  }
  if (audioContext.state === 'suspended') audioContext.resume();
  return audioContext;
}

function audioClock() { return sourceOffset + (audioContext.currentTime - sourceStartedAt); }

// Start playing the file from `offset` seconds (replacing whatever was playing).
function startAudioAt(offset) {
  stopAudio();
  const ctx = ensureAudioContext();
  const node = ctx.createBufferSource();
  const gain = ctx.createGain();
  node.buffer = audioBuffer;
  node.connect(gain);
  gain.connect(masterGain);
  const now = ctx.currentTime;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(1, now + 0.03); // tiny fade-in so starting mid-sound doesn't click
  const start = THREE.MathUtils.clamp(offset, 0, Math.max(0, audioBuffer.duration - 0.05));
  node.start(0, start);
  node.onended = () => { if (source === node) { source = null; sourceGain = null; } };
  source = node;
  sourceGain = gain;
  sourceStartedAt = now;
  sourceOffset = start;
}

function stopAudio() {
  if (!source) return;
  const node = source, gain = sourceGain, now = audioContext.currentTime;
  source = null;
  sourceGain = null;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setTargetAtTime(0, now, 0.01);          // quick fade-out so stopping doesn't click
  node.onended = () => { node.disconnect(); gain.disconnect(); };
  node.stop(now + 0.06);
}

// Called every frame: keep the sound exactly where the user is, and silent whenever it shouldn't play.
function syncAudio() {
  const t = worldTime();
  const shouldPlay = soundOn && audioBuffer && playing && !scrubbing && !document.hidden
    && playerZ < WORLD.length - 3.05                // the journey is over: don't loop the last moments
    && t < audioBuffer.duration - 0.1;
  if (!shouldPlay) { stopAudio(); return; }
  if (!source || Math.abs(audioClock() - t) > DRIFT_LIMIT) startAudioAt(t);
}

function toggleSound() {
  if (!audioBuffer) {
    showCaption('Sound is disabled because no audio was submitted.');
    return;
  }
  soundOn = !soundOn;
  if (soundOn) {
    ensureAudioContext(); // created inside the click, which is what lets the browser allow audio
    if (isSilentAt(audioBuffer, worldTime(), SILENCE_WINDOW)) showCaption('This section is silent.');
  } else {
    stopAudio();
  }
  updateSoundButton();
}

soundButton.addEventListener('click', toggleSound);
updateSoundButton();
// A hidden tab stops animating, so stop the sound too; syncAudio restarts it at the right spot on return.
document.addEventListener('visibilitychange', () => { if (document.hidden) stopAudio(); });

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
    const { features: newFeatures, audioBuffer: newBuffer } = await analyzeAudioFile(file); // slow part: decode + spectrum
    setLoading(loadingDefaultText);
    await nextFrame();                                  // let the overlay paint before the heavy build
    buildWorld(newFeatures);
    stopAudio();                                        // the new song replaces any sound that was playing
    audioBuffer = newBuffer;                            // only after the world built, so a failure keeps the old audio
    updateSoundButton();                                // unlocks the toggle (it stays Off until the user turns it on)
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
  // 'change' bubbles, so this works whether #audio-file is the file input itself or a wrapper around it.
  audioDropBox.addEventListener('change', event => {
    const input = event.target;
    handleAudioFile(input.files?.[0]).finally(() => { input.value = ''; }); // lets the same file be picked again
  });
} else {
  console.warn('No element with id "new-audio" found: audio upload is disabled.');
}

/* ---------------------------- atmosphere & camera ---------------------------- */

// Fog, sky, sunlight and weather drift toward the biome just ahead of the car, and the badge names it.
function updateAtmosphere(dt) {
  const info = terrainInfo.biomeAt(playerX, Math.min(WORLD.length, playerZ + 12));
  blendBiomeColor(info.weights, 'fog', fogRgb);
  fogTarget.setRGB(fogRgb[0], fogRgb[1], fogRgb[2]);
  const k = 1 - Math.exp(-dt * 1.5);
  scene.fog.color.lerp(fogTarget, k);
  scene.background.lerp(fogTarget, k);

  const wx = blendBiomeWeather(info.weights, weatherNow);
  wx.snow += info.weights[MOUNTAIN] * (1 - info.T) * 0.8; // mountains only snow when the music is cold
  scene.fog.density += (BASE_FOG * wx.fog - scene.fog.density) * k;
  sun.intensity += (BASE_SUN * wx.sun - sun.intensity) * k;
  weather.update(dt, camera, wx);

  // The biome is large-scale, so it only changes at the handover between pieces of a compilation; the hysteresis just
  // keeps the label steady through that handover.
  if (shownBiome < 0 || (info.dominant !== shownBiome && info.weights[info.dominant] > info.weights[shownBiome] + 0.08)) shownBiome = info.dominant;
  setBadge('Biome:', BIOMES[shownBiome].name, biomeCss(shownBiome));
}

function updateCamera(dt) {
  const forward = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
  const sideways = (keys.has('a') || keys.has('arrowright') ? 1 : 0) - (keys.has('d') || keys.has('arrowleft') ? 1 : 0);
  scrubbing = forward !== 0;
  if (forward !== 0) playerZ = THREE.MathUtils.clamp(playerZ + forward * dt * 60, 2, WORLD.length - 3);
  if (sideways !== 0) playerX += sideways * dt * 25;
  const centerX = roadCenterX(playerZ, features, seed);
  const roadLimit = Math.max(0, roadHalfWidthX(playerZ, features, seed) - 0.25);
  playerX = THREE.MathUtils.clamp(playerX, centerX - roadLimit, centerX + roadLimit);
  const ground = terrainInfo.getHeight(playerX, playerZ) + 2.1;
  const aheadZ = Math.min(WORLD.length, playerZ + 8);
  const aheadX = roadCenterX(aheadZ, features, seed);
  const target = new THREE.Vector3(aheadX, terrainInfo.getHeight(aheadX, aheadZ) + 2.2, aheadZ);
  const desired = new THREE.Vector3(playerX, ground + 2.0, playerZ - 10);
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
    // The drive runs in real time, at a speed set by the song's tempo (see Timeline.js), so the world and the sound
    // stay together.
    playerZ = Math.min(WORLD.length - 3, playerZ + dt * features.timeline.speedAt(worldTime()));
  }
  updateCamera(dt);
  updateAtmosphere(dt);
  syncAudio();
  sun.position.set(playerX - 70, 120, playerZ + 40);
  sun.target.position.set(playerX, 0, playerZ);
  sunDisk.position.set(playerX + 95, 95, playerZ + 500);
  const time = worldTime();
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
