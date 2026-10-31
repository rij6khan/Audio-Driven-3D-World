import * as THREE from 'three';
import { makeFakeAudioFeatures, sampleAudioFeatures, analyzeAudioFile, isSilentAt } from './audioData.js';
import { createTerrain } from './TerrainGenerator.js';
import { createRoad, roadCenterX, setWorldLength, WORLD } from './RoadGenerator.js';
import { createScenery } from './PropGenerator.js';
import { BIOMES, BIOME_CHOICE, MOUNTAIN, NIGHT, createBiomeMap, blendBiomeColor, blendBiomeWeather, biomeCss } from './BiomeGenerator.js';
import { createSky, skyDirection, SKY } from './Sky.js';
import { createCalibration } from './Calibration.js';
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

const hemisphere = new THREE.HemisphereLight(0xe7f4ff, 0x65714e, 2.0);
scene.add(hemisphere);
const sun = new THREE.DirectionalLight(0xffe2b5, 3.0);
sun.position.set(-70, 120, 40);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -150;
sun.shadow.camera.right = 150;
sun.shadow.camera.top = 200;
sun.shadow.camera.bottom = -100;
scene.add(sun, sun.target);

// The sky: sun, moon and stars, fixed in the world relative to the starting point (see Sky.js).
const sky = createSky(scene);
const sunDirection = skyDirection(SKY.sun.azimuth, SKY.sun.elevation);
const moonDirection = skyDirection(SKY.moon.azimuth, SKY.moon.elevation);

const weather = createWeather(scene);

// The memory of files analyzed so far, which spreads the biomes evenly over your own music (see Calibration.js).
// To start fresh, run  resetBiomeCalibration()  in the browser console.
const calibration = createCalibration();
window.resetBiomeCalibration = () => { calibration.reset(); console.info('[calibration] forgotten; the next files use the defaults again'); };

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

// The current audio file's name, as a full-width box in the HUD's stat grid.
const DEMO_NAME = 'Demo (simulated audio)';
const audioNameBox = document.createElement('div');
audioNameBox.className = 'wide';
const audioNameLabel = document.createElement('span');
audioNameLabel.className = 'stat-label';
audioNameLabel.textContent = 'AUDIO FILE';
const audioName = document.createElement('strong');
audioName.id = 'audio-name';
audioNameBox.appendChild(audioNameLabel);
audioNameBox.appendChild(audioName);
(document.querySelector('.stats') ?? document.querySelector('#hud') ?? document.body).appendChild(audioNameBox);
function setAudioName(name) {
  audioName.textContent = name;
  audioName.title = name; // the full name on hover, in case it is too long to fit
}
setAudioName(DEMO_NAME);

// The on-screen controls, kept in step with what the keys actually do.
const helpBox = document.querySelector('#help');
if (helpBox) helpBox.innerHTML = 'Drive: <b>W/S</b> or \u2191\u2193 \u00b7 Look: <b>A/D</b>, \u2190\u2192, or <b>click and drag</b> \u00b7 Recenter view: <b>C</b> \u00b7 Restart: <b>R</b>';

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
const BASE_FOG = 0.0027, BASE_SUN = 3.0, BASE_AMBIENT = 2.0;
let nightSmooth = 0; // 0 = day .. 1 = night, eased so that a handover between pieces of a compilation fades
const dayLight = new THREE.Color(0xffe2b5), moonLight = new THREE.Color(NIGHT.moonColor), lightTarget = new THREE.Color();
const daySky = new THREE.Color(0xe7f4ff), dayGround = new THREE.Color(0x65714e);
const nightSky = new THREE.Color(NIGHT.skyLight), nightGround = new THREE.Color(NIGHT.groundLight), skyTarget = new THREE.Color(), groundTarget = new THREE.Color();
const weatherNow = {};
const keys = new Set();
const clock = new THREE.Clock();
const fogTarget = new THREE.Color(), backgroundTarget = new THREE.Color(), deepSky = new THREE.Color(NIGHT.deepSky);
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
    const nextTerrain = createTerrain({ features: worldFeatures, seed, calibration });
    nextGroup.add(nextTerrain.mesh);
    nextGroup.add(nextTerrain.far); // the land carried on to the horizon
    if (nextTerrain.water) nextGroup.add(nextTerrain.water);
    const nextRoad = createRoad({ profile: nextTerrain.roadProfile });
    nextGroup.add(nextRoad);
    // Scenery goes into the world group (not the scene) so clearWorld() removes it along with the terrain.
    const nextScenery = createScenery({
      scene: nextGroup, getTerrainHeight: nextTerrain.getHeight, biomeAt: nextTerrain.biomeAt, biomeMap: nextTerrain.biomeMap, features: worldFeatures, seed,
    });

    clearWorld();
    features = worldFeatures;
    worldGroup = nextGroup;
    terrainInfo = nextTerrain;
    roadMesh = nextRoad;
    scenery = nextScenery;
    scene.add(worldGroup);
    // The reading behind the biome, so it can be checked and the scales tuned (see BIOME_CHOICE in BiomeGenerator.js).
    terrainInfo.biomeMap.parts.forEach(p => console.info(
      `[biome] ${BIOMES[p.biome].name}${p.night ? ' (night)' : ''} (${p.from.toFixed(0)}-${p.to.toFixed(0)} s) | loudness ${p.level.toFixed(1)} dBFS, beat clarity ${p.activity.toFixed(2)} | temperature ${p.T.toFixed(2)} = average of`,
      `centroid ${p.cues.centroidHz?.toFixed(0)} Hz -> ${p.scores[0]?.toFixed(2)},`,
      `slope ${p.cues.slope?.toFixed(1)} dB/oct -> ${p.scores[1]?.toFixed(2)},`,
      `treble ${p.cues.trebleDb?.toFixed(1)} dB -> ${p.scores[2]?.toFixed(2)},`,
      `tonality ${p.cues.tonality?.toFixed(2)} -> ${p.scores[3]?.toFixed(2)}`,
      `| moisture ${p.M.toFixed(2)} (sustain ${(p.sustain * 80).toFixed(1)} dB) | hill range ${p.spread.toFixed(1)}`));
    playerZ = 3;
    playerX = roadCenterX(playerZ, features, seed);
    elapsed = 0;
    shownBiome = -1;
    nightSmooth = terrainInfo.biomeMap.nightAt(playerZ);
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

// What the library remembers about one piece of music (see Calibration.js).
const observation = (p, name) => ({ name, t: p.reading, warmth: p.warmth, m: p.moisture, spread: p.spread, level: p.level, activity: p.activity, mountain: p.biome === MOUNTAIN });

// Select several files at once to MEASURE them without building a world: their readings go into the library, and a table plus
// suggested cutoffs are printed to the console (run  reportBiomeLibrary()  to print them again at any time).
async function measureLibrary(files) {
  const keepLength = WORLD.length;
  try {
    for (let i = 0; i < files.length; i++) {
      setLoading(`Measuring ${i + 1} of ${files.length}: ${files[i].name}`);
      await nextFrame();
      try {
        const { features } = await analyzeAudioFile(files[i]);
        const shaped = prepareFeatures(features);
        setWorldLength(shaped.timeline.length);
        createBiomeMap({ features: shaped, seed: 1, calibration: null }).parts.forEach(p => calibration.record(observation(p, files[i].name)));
      } catch (err) { console.warn(`[calibration] skipped ${files[i].name}: ${err.message}`); }
    }
  } finally {
    setWorldLength(keepLength);
    loading.classList.add('hidden');
    loading.textContent = loadingDefaultText;
  }
  calibration.report(BIOME_CHOICE.activityDb);
}
window.reportBiomeLibrary = () => calibration.report(BIOME_CHOICE.activityDb);

async function handleAudioFile(file) {
  if (!file) return;
  setLoading('Analyzing audio…');
  try {
    const { features: newFeatures, audioBuffer: newBuffer } = await analyzeAudioFile(file); // slow part: decode + spectrum
    setLoading(loadingDefaultText);
    await nextFrame();                                  // let the overlay paint before the heavy build
    buildWorld(newFeatures);
    // Remember this file, so later files are placed among it (it did not influence its own biome).
    terrainInfo.biomeMap.parts.forEach(p => calibration.record(observation(p, file.name)));
    console.info(`[calibration] ${calibration.count()} file(s) remembered`);
    stopAudio();                                        // the new song replaces any sound that was playing
    audioBuffer = newBuffer;                            // only after the world built, so a failure keeps the old audio
    updateSoundButton();                                // unlocks the toggle (it stays Off until the user turns it on)
    setAudioName(file.name);
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
  const fileInput = audioDropBox.matches?.('input') ? audioDropBox : audioDropBox.querySelector?.('input');
  if (fileInput) fileInput.multiple = true; // several files at once are measured, not played
  // 'change' bubbles, so this works whether #audio-file is the file input itself or a wrapper around it.
  audioDropBox.addEventListener('change', event => {
    const input = event.target;
    const files = [...(input.files ?? [])];
    (files.length > 1 ? measureLibrary(files) : handleAudioFile(files[0])).finally(() => { input.value = ''; }); // lets the same file be picked again
  });
} else {
  console.warn('No element with id "new-audio" found: audio upload is disabled.');
}

/* ------------------- drop files or a folder to measure a library ------------------- */

// Drop audio files, or a folder, anywhere on the page. One file is played, as if chosen with the file input; several files, or a
// folder (such as iTunes' Music folder, with one folder per artist), are MEASURED: about one random track per artist folder, up
// to MEASURE_LIMIT of them, then the table and suggested cutoffs are printed to the console.
const AUDIO_FILE = /\.(mp3|m4a|aac|wav|flac|aif|aiff|ogg|opus)$/i;
const SKIPPED_FOLDERS = /^(audiobooks|podcasts|books|voice memos)$/i; // spoken word would bend the cutoffs
const MEASURE_LIMIT = 60;

const listEntries = reader => new Promise((resolve, reject) => {
  const all = [];
  const next = () => reader.readEntries(batch => { if (!batch.length) return resolve(all); all.push(...batch); next(); }, reject);
  next();
});
const audioIn = async entry => { // every audio file at or below this entry
  if (entry.isFile) return AUDIO_FILE.test(entry.name) ? [entry] : [];
  if (SKIPPED_FOLDERS.test(entry.name)) return [];
  const found = [];
  for (const child of await listEntries(entry.createReader())) found.push(...await audioIn(child));
  return found;
};
const fileOf = entry => new Promise((resolve, reject) => entry.file(resolve, reject));

async function filesFromDrop(entries) {
  const groups = []; // one per artist folder, or per loose file
  for (const entry of entries) {
    if (entry.isFile) { groups.push(await audioIn(entry)); continue; }
    const children = await listEntries(entry.createReader());
    if (children.some(c => c.isDirectory)) for (const child of children) groups.push(await audioIn(child)); // a folder of artist folders
    else groups.push(...(await audioIn(entry)).map(f => [f]));                                              // a folder of loose songs
  }
  const chosen = groups.filter(g => g.length).sort(() => Math.random() - 0.5).slice(0, MEASURE_LIMIT).map(g => g[Math.floor(Math.random() * g.length)]);
  return Promise.all(chosen.map(fileOf));
}

window.addEventListener('dragover', event => event.preventDefault()); // required for the page to accept a drop
window.addEventListener('drop', async event => {
  event.preventDefault();
  const entries = [...(event.dataTransfer?.items ?? [])].map(item => item.webkitGetAsEntry?.()).filter(Boolean); // read before any await
  const loose = [...(event.dataTransfer?.files ?? [])];
  try {
    const files = entries.length ? await filesFromDrop(entries) : loose.filter(f => AUDIO_FILE.test(f.name));
    if (files.length > 1) await measureLibrary(files);
    else if (files.length === 1) await handleAudioFile(files[0]);
    else {
      setLoading('No audio files found in what was dropped');
      setTimeout(() => { loading.textContent = loadingDefaultText; loading.classList.add('hidden'); }, 3000);
    }
  } catch (err) { console.error(err); }
});

/* ---------------------------- atmosphere & camera ---------------------------- */

// Fog, sky, sunlight and weather drift toward the biome just ahead of the car, and the badge names it.
function updateAtmosphere(dt) {
  const ahead = Math.min(WORLD.length, playerZ + 12);
  const info = terrainInfo.biomeAt(playerX, ahead);
  const k = 1 - Math.exp(-dt * 1.5);
  nightSmooth += (terrainInfo.biomeMap.nightAt(ahead) - nightSmooth) * k;

  // Fog and sky take the biome's color, darkened to deep blue at night. (Whether it is day or night decides the sky; whether
  // the sun, moon or stars can be SEEN is a separate matter, below.)
  blendBiomeColor(info.weights, 'fog', fogRgb);
  backgroundTarget.setRGB(fogRgb[0], fogRgb[1], fogRgb[2]).lerp(deepSky, nightSmooth); // the sky: the day's color, fading to near-black blue at night
  for (let c = 0; c < 3; c++) fogRgb[c] *= 1 + (NIGHT.sky[c] - 1) * nightSmooth;
  fogTarget.setRGB(fogRgb[0], fogRgb[1], fogRgb[2]);
  scene.fog.color.lerp(fogTarget, k);
  scene.background.lerp(backgroundTarget, k);

  const wx = blendBiomeWeather(info.weights, weatherNow);
  wx.snow += info.weights[MOUNTAIN] * Math.max(0, 0.5 - info.T) * 1.6; // mountains snow only when the music is cold (none at or above 0.5)
  scene.fog.density += (BASE_FOG * wx.fog - scene.fog.density) * k;
  weather.update(dt, camera, wx);

  // Light: sunlight by day, dim moonlight by night, each from the direction of its body in the sky; weaker sky light at night.
  const dayStrength = BASE_SUN * wx.sun, moonStrength = BASE_SUN * NIGHT.moonLight * Math.min(1, wx.sun + 0.3);
  sun.intensity += (dayStrength * (1 - nightSmooth) + moonStrength * nightSmooth - sun.intensity) * k;
  lightTarget.copy(dayLight).lerp(moonLight, nightSmooth);
  sun.color.lerp(lightTarget, k);
  hemisphere.intensity += (BASE_AMBIENT * wx.ambient * (1 - nightSmooth * (1 - NIGHT.ambient)) - hemisphere.intensity) * k; // a dense canopy blocks sky light too
  skyTarget.copy(daySky).lerp(nightSky, nightSmooth);
  groundTarget.copy(dayGround).lerp(nightGround, nightSmooth);
  hemisphere.color.lerp(skyTarget, k);
  hemisphere.groundColor.lerp(groundTarget, k);
  let dx = sunDirection.x + (moonDirection.x - sunDirection.x) * nightSmooth;
  let dy = sunDirection.y + (moonDirection.y - sunDirection.y) * nightSmooth;
  let dz = sunDirection.z + (moonDirection.z - sunDirection.z) * nightSmooth;
  const length = Math.hypot(dx, dy, dz);
  dx /= length; dy /= length; dz /= length;
  sun.position.set(playerX + dx * 150, dy * 150, playerZ + dz * 150); // the light comes from the sun's (or moon's) place in the sky, so shadows agree with it
  sun.target.position.set(playerX, 0, playerZ);

  // How much of the sky can be seen: rain, snow and dust, thick fog and forest cover all hide it.
  const precipitation = Math.max(wx.rain, wx.snow * 0.8, wx.dust * 0.6);
  const foggy = THREE.MathUtils.clamp((wx.fog - 1.2) / 0.8, 0, 1);
  const clear = (1 - 0.92 * precipitation) * (1 - 0.7 * foggy) * (1 - wx.canopy);
  renderer.toneMappingExposure = 1.12 + (NIGHT.exposure - 1.12) * nightSmooth; // a little brighter at night so the road stays easy to see
  sky.update(camera, { night: nightSmooth, clear });

  // The biome is large-scale, so it only changes at the handover between pieces of a compilation; the hysteresis just
  // keeps the label steady through that handover.
  if (shownBiome < 0 || (info.dominant !== shownBiome && info.weights[info.dominant] > info.weights[shownBiome] + 0.08)) shownBiome = info.dominant;
  setBadge('Biome:', BIOMES[shownBiome].name + (nightSmooth > 0.5 ? ' \u00b7 Night' : ''), biomeCss(shownBiome));
}


// The camera is a driver's eye: it rides the road exactly. Its position and base orientation are a pure function of the
// position along the road (no smoothing, so it can't lag or wander): always on the centerline, a constant height above
// the road surface, facing the direction of travel (its yaw follows the road's bends, its pitch the road's grade), and
// never rolling. The only thing added on top is the driver turning their head left and right (A/D or left/right arrows).
const EYE_HEIGHT = 2.4;
const LOOK_SPEED = 1.6;              // radians per second the view turns while a look key is held
const LOOK_LIMIT = Math.PI * 0.9;    // how far round the driver can look
let lookYaw = 0, lookPitch = 0;                     // how far the view is turned from the road's direction (positive = right)
const roadPoint = {};
function updateCamera(dt) {
  const forward = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
  const turn = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
  scrubbing = forward !== 0;
  if (forward !== 0) playerZ = THREE.MathUtils.clamp(playerZ + forward * dt * 60, 2, WORLD.length - 3);
  lookYaw = THREE.MathUtils.clamp(lookYaw + turn * dt * LOOK_SPEED, -LOOK_LIMIT, LOOK_LIMIT);

  const road = terrainInfo.roadProfile.surfaceAt(playerZ, roadPoint);
  playerX = road.x;
  camera.position.set(road.x, road.y + EYE_HEIGHT, road.z);
  // Heading is the road's, turned by the driver's head; the road's grade tilts the view less the further they look to the side.
  const heading = Math.atan2(road.tx, road.tz) - lookYaw;
  const pitch = THREE.MathUtils.clamp(Math.asin(road.ty) * Math.cos(lookYaw) + lookPitch, -1.4, 1.4);
  camera.lookAt(
    road.x + Math.sin(heading) * Math.cos(pitch),
    road.y + EYE_HEIGHT + Math.sin(pitch),
    road.z + Math.cos(heading) * Math.cos(pitch),
  );
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
    lookYaw = 0; lookPitch = 0;
  }
  if (key === 'c') { lookYaw = 0; lookPitch = 0; } // recenter the view along the road
});
window.addEventListener('keyup', event => keys.delete(event.key.toLowerCase()));

// Click and drag to look around: the view follows the grab, as if dragging the world. C or R recenters.
const DRAG_SPEED = 0.004; // radians per pixel
let dragging = false, dragX = 0, dragY = 0;
const surface = renderer.domElement;
if (surface.style) { surface.style.touchAction = 'none'; surface.style.cursor = 'grab'; }
surface.addEventListener?.('pointerdown', event => {
  dragging = true; dragX = event.clientX; dragY = event.clientY;
  surface.setPointerCapture?.(event.pointerId);
  if (surface.style) surface.style.cursor = 'grabbing';
});
surface.addEventListener?.('pointermove', event => {
  if (!dragging) return;
  lookYaw = THREE.MathUtils.clamp(lookYaw - (event.clientX - dragX) * DRAG_SPEED, -LOOK_LIMIT, LOOK_LIMIT);
  lookPitch = THREE.MathUtils.clamp(lookPitch + (event.clientY - dragY) * DRAG_SPEED, -1.2, 1.2);
  dragX = event.clientX; dragY = event.clientY;
});
const endDrag = () => { dragging = false; if (surface.style) surface.style.cursor = 'grab'; };
surface.addEventListener?.('pointerup', endDrag);
surface.addEventListener?.('pointercancel', endDrag);
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
