import { WORLD } from './RoadGenerator.js';
import { bandAxisToHz, SPECTRUM_DB_RANGE } from './audioData.js';
import { DRIVE } from './Timeline.js';

/**
 * Biomes are large-scale things, so each audio file gets ONE biome and keeps it, chosen from the sound of the whole
 * file. (Only a file that is plainly a compilation of unrelated pieces gets more than one; see COMPILATION.)
 *
 *   TEMPERATURE is judged holistically, from the whole file's long-term average spectrum, as the average of four
 *                cues, each on a fixed physical scale (Hz, dB per octave, dB; nothing is normalized to the file itself):
 *                where the sound's balance point sits, how steeply the spectrum falls toward the treble, how much
 *                energy there is up in the treble, and how tonal (versus noisy) it is. Dark, mellow, tonal sound is
 *                warm; bright, thin, icy, noisy sound is cold.
 *   MOISTURE    is how SUSTAINED the low half is: its average level against its own typical peaks. Steady, flowing
 *                sound is wet; punchy, sparse sound is dry.
 *   Each is measured so that it does not depend on the other, or on how loud the file's single loudest moment was.
 *   MOUNTAINS   are chosen instead when the file's dynamics make the hills span a large range of heights.
 *
 * Inside the biome, WATER still appears locally: pools and streams where the low half's steadiness spikes far above its
 * surroundings (an oasis in a desert, a lake in a forest).
 */

/* ----------------------------- tuning knobs ----------------------------- */
// Water: local moisture spikes, measured across the road (see createBiomeMap).
export const BIOME_SETTINGS = {
  roadBandSpan: 55,         // world units either side of the road that are spread over the low half's frequency range
  smoothBeats: 6,           // blur along the road, in beats (a beat is DRIVE.unitsPerBeat long)
  smoothX: 6,               // blur across the road in world units
  anomalyBeats: 20,         // size of the "surroundings" used to decide whether moisture is extreme locally
  anomalyX: 20,
  waterPercentLow: 0.94,    // a cell starts becoming water only if its moisture-above-surroundings is in the top 6% of the file...
  waterPercentHigh: 0.985,  // ...and is fully water in the top 1.5%
  waterFloorLow: 0.12,      // but never for a spike smaller than this, so a steady file gets no water at all
  waterFloorHigh: 0.24,
};

// Which biome a file gets. The levels are of the spectrum (0..1 = 0 to 80 dB below the file's loudest moment).
export const BIOME_CHOICE = {
  // Temperature cues: [value that counts as coldest, value that counts as warmest]. Each is on a fixed physical scale.
  centroidHz: [600, 70],       // balance point of the sound's ENERGY (Hz, judged by octaves; bass carries most of the energy, so it sits low)
  slopeDbPerOct: [-4.5, -10],  // how fast the spectrum falls with frequency (a mix is typically around -7.5)
  trebleDb: [-12, -45],        // energy above 4 kHz relative to all energy (dB)
  tonality: [0.25, 0.75],      // 0 = noise-like, 1 = one clear tone stands out (the average of the per-moment values)
  sustainDry: -0.20, sustainWet: -0.03, // low-half average level minus its own 95th-percentile level: at or below sustainDry (-16 dB, a very dynamic file) is the driest, at or above sustainWet (-2 dB, a steady, heavily compressed one) the wettest
  mountainSpread: 25,                  // hills spanning at least this many height units (5th to 95th percentile) make it mountains
  silenceDb: -50,                      // quieter than this isn't sound, and is left out of every average
};

// A file counts as a compilation of unrelated pieces only with strong evidence: ALL of these at once.
// Biomes are large-scale, so the pieces must be long: a biome never changes on a local scale.
export const COMPILATION = {
  gapSeconds: 1.5,       // true silence at least this long separates two pieces...
  minPartSeconds: 60,    // ...each of the two must itself run at least this long (a minute or more of road)...
  minDifference: 0.10,   // ...and their average spectra must differ by at least this (about 8 dB per band on average).
  blendUnits: 30,        // road length over which one piece's biome hands over to the next
};

/* ----------------------------- biome table ------------------------------ */
// Anchors: T = temperature (0 cold .. 1 hot), M = moisture (0 dry .. 1 wet).
// The last entry (mountains) is not on the grid: it takes over wherever the terrain is rugged.
// Colors are sRGB hex. Tree shapes: 'cone' | 'round' | 'umbrella' | 'cactus' | 'shrub' | 'reed'.
// Sunny biomes (steppe, temperate forest, desert) have no falling or suspended particles at all.
// `weather` (0..1 each, fog, sun and ambient are multipliers): snow, rain and dust set the falling particles; fog scales the
// fog thickness; sun scales the sunlight (overcast < 1 < bright) and ambient the sky light (default 1).
// Snow biomes (tundra, taiga) are winter-colored: snow-covered ground, frosted conifers; the tundra is also largely barren.
// The rainforest is deliberately extreme: so many tall trees, plus a leafy ceiling over the road, that the sky is mostly
// hidden (`dense`; see PropGenerator), with little light getting through (`sun`, `ambient`) and constant heavy rain.
// Each biome is modeled on real references: tundra is treeless plain of mosses, lichens and sedges; taiga is dense dark
// conifers with pointed crowns; desert is sand and sandstone with sparse cacti; savanna is tufted grass with scattered
// umbrella-shaped acacias; rainforest is a dense layered canopy under heavy rain; bogs are peat moss and sparse spruce
// under fog; marshes are reeds, sedges and open water.
export const BIOMES = [
  { id: 'tundra', name: 'Tundra', T: 0.15, M: 0.15,
    ground: [0xdce6ec, 0x9ea4a6], water: 0xa9c7d6, fog: 0xe0e9ef, rock: 0x6f7679, rockDensity: 0.45,
    tree: { shape: 'shrub', colors: [0x8a8f86, 0x9a9486], density: 0.04, size: [0.7, 1.3] },
    weather: { snow: 0.9, rain: 0, dust: 0, fog: 1.4, sun: 0.75 } },
  { id: 'steppe', name: 'Steppe', T: 0.5, M: 0.15,
    ground: [0xb4b062, 0xc9b87a], water: 0x6fa3b2, fog: 0xd9dcc0, rock: 0x908a74, rockDensity: 0.5,
    tree: { shape: 'shrub', colors: [0x9aa04e, 0xb0a85a], density: 0.22, size: [0.9, 1.9] },
    weather: { snow: 0, rain: 0, dust: 0, fog: 0.9, sun: 1.1 } },
  { id: 'desert', name: 'Desert', T: 0.85, M: 0.15,
    ground: [0xe0bd70, 0xb8693e], water: 0x35b3a8, fog: 0xf2dcae, rock: 0xb87850, rockDensity: 0.9,
    tree: { shape: 'cactus', colors: [0x5d8f4e, 0x6b9a58], density: 0.12, size: [1.8, 3.6] },
    weather: { snow: 0, rain: 0, dust: 0, fog: 0.8, sun: 1.3 } },
  { id: 'taiga', name: 'Taiga', T: 0.15, M: 0.5,
    ground: [0xe8eff2, 0xf4f8fa], water: 0x9bbccb, fog: 0xd2dde2, rock: 0x7a8187, rockDensity: 0.3,
    tree: { shape: 'cone', colors: [0xcfddda, 0xe9f0ef, 0x2c4d40, 0xbdd0cb], density: 0.9, size: [2.2, 4.8] },
    weather: { snow: 0.8, rain: 0, dust: 0, fog: 1.3, sun: 0.8 } },
  { id: 'forest', name: 'Temperate forest', T: 0.5, M: 0.5,
    ground: [0x3f7d3f, 0x6e8c4b], water: 0x4f8fa8, fog: 0xbcd7d9, rock: 0x777d76, rockDensity: 0.4,
    tree: { shape: 'round', colors: [0x3c7a3c, 0x4f8f3a, 0x6aa03f, 0xc08a2e], density: 0.75, size: [2.0, 4.6] },
    weather: { snow: 0, rain: 0, dust: 0, fog: 1.0, sun: 1.0 } },
  { id: 'savanna', name: 'Savanna', T: 0.85, M: 0.5,
    ground: [0xc9a94a, 0xa88b4a], water: 0x6da08c, fog: 0xeadcb4, rock: 0x9a8160, rockDensity: 0.5,
    tree: { shape: 'umbrella', colors: [0x7f8f34, 0x95a23c], density: 0.14, size: [2.8, 5.2] },
    weather: { snow: 0, rain: 0, dust: 0.35, fog: 0.8, sun: 1.2 } },
  { id: 'boreal-bog', name: 'Boreal bog', T: 0.15, M: 0.85,
    ground: [0x5e6e4a, 0x806a4f], water: 0x2f4a50, fog: 0xb4c2c6, rock: 0x6f777a, rockDensity: 0.25,
    tree: { shape: 'cone', colors: [0x2b4a3d, 0x34574a], density: 0.3, size: [1.4, 3.2] },
    weather: { snow: 0.25, rain: 0.35, dust: 0, fog: 1.9, sun: 0.6 } },
  { id: 'marsh', name: 'Marsh', T: 0.5, M: 0.85,
    ground: [0x5f7a45, 0x7e8a50], water: 0x4d7048, fog: 0xb6c8b4, rock: 0x6f7468, rockDensity: 0.1,
    tree: { shape: 'reed', colors: [0xb8a864, 0x7e9a4a, 0x6a7f3c], density: 0.6, size: [1.6, 3.0] },
    weather: { snow: 0, rain: 0.3, dust: 0, fog: 1.7, sun: 0.8 } },
  { id: 'rainforest', name: 'Rainforest', T: 0.85, M: 0.85,
    ground: [0x123f1f, 0x1f5a2b], water: 0x24574a, fog: 0x5c8a6c, rock: 0x4a5a48, rockDensity: 0.15,
    tree: { shape: 'round', colors: [0x145a28, 0x1c6e32, 0x104a22, 0x23803a], density: 1.0, size: [8, 16], dense: true },
    weather: { snow: 0, rain: 1.0, dust: 0, fog: 1.9, sun: 0.3, ambient: 0.45 } },
  { id: 'mountains', name: 'Mountains', T: null, M: null,
    ground: [0x7d817a, 0x8d8178], water: 0x6fa0b8, fog: 0xc4d0d8, rock: 0x80868a, rockDensity: 1.0,
    tree: { shape: 'cone', colors: [0x264a3a, 0x30584a], density: 0.15, size: [1.4, 3.0], maxHeight: 35 }, // (no trees above the tree line)
    weather: { snow: 0, rain: 0, dust: 0, fog: 0.9, sun: 1.0 } },
];
export const MOUNTAIN = BIOMES.length - 1;
const SNOW = [0.9, 0.93, 0.94]; // linear rgb

// Precompute linear-light rgb for every color (vertex colors are interpreted as linear by three.js).
for (const b of BIOMES) {
  b.lin = { low: hexToLinear(b.ground[0]), high: hexToLinear(b.ground[1]), water: hexToLinear(b.water), fog: hexToLinear(b.fog) };
}

export function hexToLinear(hex) {
  const c = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return [c((hex >> 16) & 255), c((hex >> 8) & 255), c(hex & 255)];
}

// Ground color of one biome at a normalized height h01 (0 = valley, 1 = high), written into out[0..2].
export function biomeGroundColor(index, h01, T, out) {
  const { low, high } = BIOMES[index].lin;
  const k = smoothstep(0.35, 0.9, h01);
  for (let c = 0; c < 3; c++) out[c] = low[c] + (high[c] - low[c]) * k;
  if (index === MOUNTAIN) {
    // Colder mountains grow snow lower down.
    const snow = smoothstep(0.55, 0.85, h01 + (0.5 - T) * 0.5);
    for (let c = 0; c < 3; c++) out[c] += (SNOW[c] - out[c]) * snow;
  }
  return out;
}

// Weighted average of the weather settings of every biome present: { snow, rain, dust, fog, sun }.
export function blendBiomeWeather(weights, out = {}) {
  out.snow = out.rain = out.dust = out.fog = out.sun = out.ambient = 0;
  for (let i = 0; i < BIOMES.length; i++) {
    const w = weights[i];
    if (w < 0.002) continue;
    const wx = BIOMES[i].weather;
    out.snow += w * wx.snow; out.rain += w * wx.rain; out.dust += w * wx.dust; out.fog += w * wx.fog; out.sun += w * wx.sun;
    out.ambient += w * (wx.ambient ?? 1);
  }
  return out;
}

// A biome's signature color as CSS, for the on-screen label.
export function biomeCss(index) {
  return '#' + BIOMES[index].ground[0].toString(16).padStart(6, '0');
}

// Weighted average of a per-biome rgb triple ('water' or 'fog'), written into out[0..2].
export function blendBiomeColor(weights, key, out) {
  out[0] = out[1] = out[2] = 0;
  for (let i = 0; i < BIOMES.length; i++) {
    const w = weights[i];
    if (w < 0.002) continue;
    const rgb = BIOMES[i].lin[key];
    out[0] += w * rgb[0]; out[1] += w * rgb[1]; out[2] += w * rgb[2];
  }
  return out;
}

// Features from other sources may lack `spectrum`; synthesize a plausible one from pitch and volume so
// the biome system never crashes (the result is only a rough stand-in).
function ensureSpectrum(samples) {
  if (samples[0]?.spectrum?.length) return samples;
  const B = 32;
  return samples.map(s => ({
    ...s,
    spectrum: Array.from({ length: B }, (_, b) => {
      const d = (b / (B - 1) - s.pitch) / 0.18;
      return clamp(0.15 + s.volume * 0.5 * Math.exp(-d * d), 0, 1);
    }),
  }));
}


/* ------------------------------ choosing a biome --------------------------- */

const silent = s => (s.loudness ?? 0) < BIOME_CHOICE.silenceDb; // (the demo has no loudness, so it is never silent)

// Average spectrum shape of the sound between two times, with the overall level removed; null if it is all silence.
function profile(samples, from, to) {
  const sound = samples.filter(s => s.time >= from && s.time < to && !silent(s));
  if (!sound.length) return null;
  const bands = sound[0].spectrum.length, mean = new Float64Array(bands);
  for (const s of sound) for (let b = 0; b < bands; b++) mean[b] += s.spectrum[b] / sound.length;
  const level = mean.reduce((a, v) => a + v, 0) / bands;
  return Array.from(mean, v => v - level);
}

// Split the file only if it is plainly several unrelated pieces joined together (see COMPILATION). Normally: one part.
export function findParts(samples, duration) {
  const gaps = [];
  let start = null;
  for (const s of samples) {
    if (silent(s)) { if (start === null) start = s.time; }
    else if (start !== null) { if (s.time - start >= COMPILATION.gapSeconds) gaps.push({ from: start, to: s.time }); start = null; }
  }
  // (silence running to the very end is just an ending, so it never counts as a gap between pieces)

  const parts = [{ from: 0, to: duration }];
  gaps.forEach((gap, g) => {
    const current = parts[parts.length - 1];
    const nextStart = g + 1 < gaps.length ? gaps[g + 1].from : duration;
    if (gap.from - current.from < COMPILATION.minPartSeconds || nextStart - gap.to < COMPILATION.minPartSeconds) return;
    const before = profile(samples, current.from, gap.from), after = profile(samples, gap.to, nextStart);
    if (!before || !after) return;
    let difference = 0;
    for (let b = 0; b < before.length; b++) difference += Math.abs(before[b] - after[b]) / before.length;
    if (difference < COMPILATION.minDifference) return;
    const boundary = (gap.from + gap.to) / 2;
    current.to = boundary;
    parts.push({ from: boundary, to: duration });
  });
  return parts;
}

// The long-term average spectrum of the sound, and four absolute descriptions of it.
function describeSpectrum(sound, bands) {
  const hz = [], width = [], power = new Float64Array(bands);
  for (let b = 0; b < bands; b++) {
    hz.push(bandAxisToHz((b + 1) / (bands + 1)));
    width.push((bandAxisToHz((b + 2) / (bands + 1)) - bandAxisToHz(b / (bands + 1))) / 2);
  }
  for (const s of sound) for (let b = 0; b < bands; b++) power[b] += Math.pow(10, ((s.spectrum[b] - 1) * SPECTRUM_DB_RANGE) / 10) / sound.length; // power per bin
  const energy = power.map((p, b) => p * width[b]);                        // power in each band
  const total = energy.reduce((a, v) => a + v, 0) || 1e-12;
  const octave = hz.map(Math.log2), db = Array.from(power, p => 10 * Math.log10(p + 1e-12));
  const meanOct = octave.reduce((a, v) => a + v, 0) / bands, meanDb = db.reduce((a, v) => a + v, 0) / bands;
  let cov = 0, variance = 0;
  octave.forEach((o, b) => { cov += (o - meanOct) * (db[b] - meanDb); variance += (o - meanOct) ** 2; });
  let treble = 0;
  hz.forEach((f, b) => { if (f >= 4000) treble += energy[b]; });
  return {
    centroidHz: Math.pow(2, octave.reduce((a, o, b) => a + o * energy[b], 0) / total),   // where the energy balances, by octaves
    slope: cov / variance,                                                                  // dB per octave
    trebleDb: 10 * Math.log10(treble / total + 1e-12),                                      // share of energy above 4 kHz
    tonality: sound.reduce((a, s) => a + (s.tonality ?? 0.5), 0) / sound.length,
  };
}

// Temperature, moisture and hill range of the sound between two times, and the biome they point to.
function chooseBiome(samples, from, to) {
  const sound = samples.filter(s => s.time >= from && s.time < to && !silent(s));
  if (!sound.length) return { biome: 0, T: 0.5, M: 0.5, spread: 0, sustain: 0, cues: {}, scores: [] };
  const bands = sound[0].spectrum.length, half = Math.floor(bands / 2);
  const level = (s, from, to) => { let sum = 0; for (let b = from; b < to; b++) sum += s.spectrum[b]; return sum / (to - from); };
  const lows = sound.map(s => level(s, 0, half));
  const mean = v => v.reduce((a, x) => a + x, 0) / v.length;
  const sorted = [...lows].sort((a, b) => a - b);

  // Moisture: the low half's average level against its own peaks.
  const sustain = mean(lows) - sorted[Math.floor(0.95 * (sorted.length - 1))];
  const M = clamp((sustain - BIOME_CHOICE.sustainDry) / (BIOME_CHOICE.sustainWet - BIOME_CHOICE.sustainDry), 0, 1);

  // Temperature: four cues from the file's long-term average spectrum, each scored 0 (cold) to 1 (warm) on its own
  // fixed physical scale, then averaged.
  const cues = describeSpectrum(sound, bands);
  const score = (value, [cold, warm]) => clamp((value - cold) / (warm - cold), 0, 1);
  const scores = [
    score(Math.log2(cues.centroidHz), BIOME_CHOICE.centroidHz.map(Math.log2)),
    score(cues.slope, BIOME_CHOICE.slopeDbPerOct),
    score(cues.trebleDb, BIOME_CHOICE.trebleDb),
    score(cues.tonality, BIOME_CHOICE.tonality),
  ];
  const T = scores.reduce((a, v) => a + v, 0) / scores.length;

  const heights = sound.map(s => s.relief ?? 0).sort((a, b) => a - b);
  const spread = heights[Math.floor(0.95 * (heights.length - 1))] - heights[Math.floor(0.05 * (heights.length - 1))];
  if (spread >= BIOME_CHOICE.mountainSpread) return { biome: MOUNTAIN, T, M, spread, sustain, cues, scores };

  let best = 0, bestDistance = Infinity;
  for (let i = 0; i < MOUNTAIN; i++) {
    const d = (T - BIOMES[i].T) ** 2 + (M - BIOMES[i].M) ** 2;
    if (d < bestDistance) { bestDistance = d; best = i; }
  }
  return { biome: best, T, M, spread, sustain, cues, scores };
}

/* ------------------------------ the biome map ------------------------------ */

export function createBiomeMap({ features, seed = 1 }) {
  const samples = ensureSpectrum(features.samples);
  const N = samples.length;
  const B = samples[0].spectrum.length;
  const H = Math.floor(B / 2);                     // bands per half
  const duration = features.duration;
  const dt = N > 1 ? duration / (N - 1) : 1;       // seconds between rows
  const bandSpacing = (2 * BIOME_SETTINGS.roadBandSpan) / Math.max(1, H - 1); // world units between sub-bands

  // The file's biome(s), and where along the road each applies.
  const zOf = t => (features.timeline ? features.timeline.zAt(t) : (t / duration) * WORLD.length);
  const parts = findParts(samples, duration).map(p => ({ ...p, ...chooseBiome(samples, p.from, p.to), zFrom: zOf(p.from), zTo: zOf(p.to) }));

  // Biome weights at road position z (a single 1, except in the short handover between two pieces of a compilation).
  // Returns the index of the strongest biome.
  // How much of the road at z belongs to part k of the file (1 inside it, easing over blendUnits at each boundary).
  const partWeight = (k, z) => {
    const p = parts[k], blend = COMPILATION.blendUnits;
    const entered = k === 0 ? 1 : smoothstep(p.zFrom - blend, p.zFrom + blend, z);
    const left = k === parts.length - 1 ? 0 : smoothstep(p.zTo - blend, p.zTo + blend, z);
    return entered - left;
  };
  function weightsAt(z, out) {
    out.fill(0);
    let best = parts[0].biome, bestWeight = -1;
    parts.forEach((p, k) => { out[p.biome] += partWeight(k, z); });
    for (let i = 0; i < out.length; i++) if (out[i] > bestWeight) { bestWeight = out[i]; best = i; }
    return best;
  }
  // How mountainous the road at z is (0..1): the terrain asks this to know where to raise peaks.
  const hasMountains = parts.some(p => p.biome === MOUNTAIN);
  const mountainAt = z => { let w = 0; parts.forEach((p, k) => { if (p.biome === MOUNTAIN) w += partWeight(k, z); }); return w; };
  const partAt = z => parts.find((p, k) => k === parts.length - 1 || z < p.zTo) ?? parts[parts.length - 1];

  // Water: the low half of the spectrum, laid across the road (time along it, frequency across it).
  const low = new Float32Array(N * H);
  samples.forEach((s, i) => { for (let u = 0; u < H; u++) low[i * H + u] = s.spectrum[u]; });
  const secondsPerUnit = duration / WORLD.length;
  const sigmaT = (BIOME_SETTINGS.smoothBeats * DRIVE.unitsPerBeat * secondsPerUnit) / dt;
  const sigmaB = BIOME_SETTINGS.smoothX / bandSpacing;
  const bigT = (BIOME_SETTINGS.anomalyBeats * DRIVE.unitsPerBeat * secondsPerUnit) / dt;
  const bigB = BIOME_SETTINGS.anomalyX / bandSpacing;
  const moist = normalizeBands(blur2D(low, N, H, sigmaT, sigmaB), N, H);

  // Moisture that stands far above its surroundings becomes water. "Extremely high" is judged against this file: the
  // thresholds are percentiles of its own spikes, but never below an absolute floor (so a steady file gets no water).
  const surroundings = blur2D(moist, N, H, bigT, bigB);
  const anomaly = new Float32Array(N * H);
  for (let k = 0; k < anomaly.length; k++) anomaly[k] = moist[k] - surroundings[k];
  const sortedAnomaly = Float32Array.from(anomaly).sort();
  const pct = p => sortedAnomaly[Math.floor(p * (sortedAnomaly.length - 1))];
  const waterLo = Math.max(BIOME_SETTINGS.waterFloorLow, pct(BIOME_SETTINGS.waterPercentLow));
  const waterHi = Math.max(BIOME_SETTINGS.waterFloorHigh, pct(BIOME_SETTINGS.waterPercentHigh), waterLo + 0.05);
  const water = new Float32Array(N * H);
  for (let k = 0; k < water.length; k++) water[k] = smoothstep(waterLo, waterHi, anomaly[k]);

  // Bilinear lookup of the water field at a ground position. Writes `water` into `out`.
  function fieldsAt(x, z, roadX, out = {}) {
    const ti = clamp((features.timeline ? features.timeline.timeAt(z) : (z / WORLD.length) * duration) / duration, 0, 1) * (N - 1);
    const u = clamp((x - roadX) / BIOME_SETTINGS.roadBandSpan, -1, 1); // +1 = far +x bank
    const bi = (0.5 - u / 2) * (H - 1);                                  // +x bank = bottom of the range
    const i0 = Math.max(0, Math.min(N - 2, Math.floor(ti))), b0 = Math.max(0, Math.min(H - 2, Math.floor(bi)));
    const i1 = Math.min(N - 1, i0 + 1), b1 = Math.min(H - 1, b0 + 1);
    const ft = N > 1 ? ti - i0 : 0, fb = H > 1 ? bi - b0 : 0;
    const top = water[i0 * H + b0] * (1 - fb) + water[i0 * H + b1] * fb;
    const bottom = water[i1 * H + b0] * (1 - fb) + water[i1 * H + b1] * fb;
    out.water = top * (1 - ft) + bottom * ft;
    return out;
  }

  return { fieldsAt, weightsAt, partAt, parts, hasMountains, mountainAt };
}

/* -------------------------------- helpers ------------------------------- */

function gaussianKernel(sigma) {
  if (sigma < 0.3) return [1];
  const radius = Math.min(Math.ceil(3 * sigma), 60);
  const k = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) { const v = Math.exp(-0.5 * (i / sigma) ** 2); k.push(v); sum += v; }
  return k.map(v => v / sum);
}

// Separable Gaussian blur of an N rows x B bands grid; edges repeat their nearest value.
function blur2D(data, N, B, sigmaRows, sigmaBands) {
  const kr = gaussianKernel(sigmaRows), rr = (kr.length - 1) / 2;
  const kb = gaussianKernel(sigmaBands), rb = (kb.length - 1) / 2;
  const tmp = new Float32Array(N * B);
  for (let i = 0; i < N; i++) {
    for (let b = 0; b < B; b++) {
      let s = 0;
      for (let j = -rr; j <= rr; j++) s += kr[j + rr] * data[clamp(i + j, 0, N - 1) * B + b];
      tmp[i * B + b] = s;
    }
  }
  const out = new Float32Array(N * B);
  for (let i = 0; i < N; i++) {
    for (let b = 0; b < B; b++) {
      let s = 0;
      for (let j = -rb; j <= rb; j++) s += kb[j + rb] * tmp[i * B + clamp(b + j, 0, B - 1)];
      out[i * B + b] = s;
    }
  }
  return out;
}

// Rescale each band separately across time so its 5th..95th percentile spans 0..1.
function normalizeBands(data, N, B) {
  const out = new Float32Array(N * B);
  const column = new Float32Array(N);
  for (let b = 0; b < B; b++) {
    for (let i = 0; i < N; i++) column[i] = data[i * B + b];
    const sorted = Float32Array.from(column).sort();
    const lo = sorted[Math.floor(0.05 * (N - 1))];
    const hi = sorted[Math.floor(0.95 * (N - 1))];
    const range = hi - lo;
    for (let i = 0; i < N; i++) out[i * B + b] = range < 1e-6 ? 0.5 : clamp((column[i] - lo) / range, 0, 1);
  }
  return out;
}

export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
