/**
 * Audio features for the world generators.
 *
 * Contract: { duration: seconds, samples: [{ time, volume, pitch, energy, spectrum, ... }] }
 *   Real-audio samples also carry `loudness` (dBFS, absolute) and `tempo` (BPM at that moment). FeatureShaper turns
 *   loudness into `relief` (terrain height in world units); Timeline turns tempo into driving speed.
 *   volume, pitch, energy : numbers in [0, 1]
 *   spectrum              : array of SPECTRUM_BANDS numbers in [0, 1]: the power in each frequency band, in dB.
 *                           (0 = 80 dB or more below the loudest moment of the track, 1 = the loudest.)
 *                           The frequency axis is log-spaced and warped so that SPECTRUM_SPLIT_HZ (8 kHz) is exactly
 *                           halfway: the first half of the bands covers 40 Hz - 8 kHz, the second half 8 - 16 kHz.
 *
 * Two sources produce this shape:
 *   makeFakeAudioFeatures()  - synthetic demo data, used until a file is chosen
 *   makeAudioFeatures(file)  - real analysis of an uploaded audio file (browser only)
 */

export const SPECTRUM_BANDS = 32;          // first 16 = below the split, last 16 = above it
export const SPECTRUM_LOW_HZ = 40;
export const SPECTRUM_SPLIT_HZ = 8000;     // lands exactly at the halfway point of the band axis
export const SPECTRUM_HIGH_HZ = 16000;     // lossy files (mp3/aac) often have nothing above this

const ANALYSIS_RATE = 44100;  // 44.1 kHz so there is real signal above 8 kHz to analyze
const FFT_SIZE = 4096;        // ~93 ms window at 44.1 kHz
const BAND_HOP = 2048;        // spacing of FFT frames averaged inside each output sample
export const SPECTRUM_DB_RANGE = 80; // dB below the track's loudest moment that maps to 0

/* ------------------------------------------------------------------------- *
 * Demo data
 * ------------------------------------------------------------------------- */

export function makeFakeAudioFeatures(seed = 1, duration = 48, sampleRate = 0.25) {
  const samples = [];
  const count = Math.ceil(duration / sampleRate);
  let state = (seed >>> 0) || 1;
  const random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
  let smoothNoise = 0.5;

  for (let i = 0; i <= count; i++) {
    const time = Math.min(i * sampleRate, duration);
    const slowWave = 0.5 + 0.5 * Math.sin(time * 0.19 + seed * 0.7);
    const midWave = 0.5 + 0.5 * Math.sin(time * 0.61 + seed * 1.3);
    smoothNoise += (random() - smoothNoise) * 0.28;
    // Occasional simulated beats/accents create recognizable peaks in the world.
    const beat = Math.pow(Math.max(0, Math.sin(time * (1.0 + seed * 0.025))), 12);
    const volume = clamp(0.12 + 0.42 * slowWave + 0.24 * midWave + 0.16 * smoothNoise + 0.20 * beat, 0, 1);
    const pitch = clamp(0.15 + 0.65 * (0.5 + 0.5 * Math.sin(time * 0.37 + seed)) + (random() - 0.5) * 0.16, 0, 1);
    const energy = clamp(0.55 * volume + 0.30 * Math.abs(midWave - slowWave) + 0.15 * beat, 0, 1);

    // A synthetic spectrum slice: energy falls off with frequency (more steeply above the split), plus two
    // drifting waves so the spectrum changes both over time and from band to band.
    const spectrum = [];
    const half = SPECTRUM_BANDS / 2;
    for (let b = 0; b < SPECTRUM_BANDS; b++) {
      const upper = b >= half;
      const f = (upper ? b - half : b) / (half - 1);
      const tilt = upper ? 0.34 - 0.16 * f : 0.74 - 0.34 * f;
      const waveA = Math.sin(time * 0.21 + b * 0.33 + seed * 0.9);
      const waveB = Math.sin(time * 0.47 - b * 0.21 + seed * 1.7);
      const lowBeat = upper ? 0 : beat * (1 - f) * 0.3;
      spectrum.push(round4(clamp(tilt + 0.14 * waveA + 0.12 * waveB + 0.2 * (volume - 0.5) + lowBeat, 0, 1)));
    }
    const relief = 3 + Math.pow(volume, 1.55) * 23; // the demo's hill height, exactly as the terrain used to compute it
    // Alternating prominence: the melody is clearest when the rhythm is faint, and the other way round.
    const swing = 0.5 + 0.5 * Math.sin(time * 0.13 + seed);
    samples.push({ time, volume, pitch, energy, spectrum, relief, complexity: energy, tonality: swing, pulse: 1 - swing });
  }
  // A steady 100 BPM pulse (the demo's pace), with a strong-weak-medium-weak accent pattern.
  const beats = { time: [], strength: [] };
  for (let k = 0; k * 0.6 < duration; k++) { beats.time.push(k * 0.6); beats.strength.push([1, 0.5, 0.8, 0.5][k % 4]); }
  return { duration, samples, beats };
}

export function sampleAudioFeatures(features, time) {
  const samples = features.samples;
  if (!samples?.length) return { volume: 0, pitch: 0.5, energy: 0 };
  const t = clamp(time, 0, features.duration);
  let low = 0;
  let high = samples.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (samples[mid].time < t) low = mid + 1;
    else high = mid;
  }
  const b = samples[low];
  const a = samples[Math.max(0, low - 1)];
  const span = b.time - a.time;
  const f = span > 0 ? (t - a.time) / span : 0;

  // A cubic curve through four neighboring samples: it has no corners at the samples, which keeps the road's bends smooth.
  const smooth = key => {
    const p0 = samples[Math.max(0, low - 2)][key] ?? 0.5, p1 = a[key] ?? 0.5, p2 = b[key] ?? 0.5, p3 = samples[Math.min(samples.length - 1, low + 1)][key] ?? 0.5;
    return 0.5 * (2 * p1 + (p2 - p0) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (3 * p1 - p0 - 3 * p2 + p3) * f * f * f);
  };

  return {
    volume: lerp(a.volume, b.volume, f),
    pitch: smooth('pitch'),
    energy: smooth('energy'),
    // How prominent the melody and the rhythm are here (0..1); set by FeatureShaper, they steer the road.
    melodySay: smooth('melodySay'),
    rhythmSay: smooth('rhythmSay'),
    // How busy the music is (0..1); features without it fall back to energy.
    complexity: lerp(a.complexity ?? a.energy, b.complexity ?? b.energy, f),
    // Hill height in world units. Features that haven't been shaped yet fall back to the original volume formula.
    relief: a.relief !== undefined && b.relief !== undefined
      ? lerp(a.relief, b.relief, f)
      : 3 + Math.pow(lerp(a.volume, b.volume, f), 1.55) * 23,
  };
}

/* ------------------------------------------------------------------------- *
 * Real audio analysis
 *
 * Two stages, so each can be tested on its own:
 *   1. makeAudioFeatures(file)  - browser-only: File -> decoded audio -> raw numbers
 *   2. analyzeSignal(...)       - pure math: raw numbers -> features object
 * ------------------------------------------------------------------------- */

// Decode a file and analyze it. Returns the features for the world AND the decoded audio, so the page can
// also play it back.
export async function analyzeAudioFile(file, sampleInterval = 0.25) {
  const arrayBuffer = await file.arrayBuffer();
  // An OfflineAudioContext decodes audio without playing it (and without needing a click).
  const ctx = new OfflineAudioContext(1, 1, ANALYSIS_RATE);
  let audioBuffer;
  try {
    audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  } catch {
    throw new Error(`Couldn't decode "${file.name}". Try a .wav or .mp3 file.`);
  }
  return { features: analyzeSignal(toMono(audioBuffer), audioBuffer.sampleRate, sampleInterval), audioBuffer };
}

// Features only (the decoded audio is discarded).
export async function makeAudioFeatures(file, sampleInterval = 0.25) {
  return (await analyzeAudioFile(file, sampleInterval)).features;
}

// Is the audio essentially silent for `windowSeconds` starting at `time`? (RMS below about -60 dBFS.)
export function isSilentAt(audioBuffer, time, windowSeconds = 1, threshold = 0.001) {
  const rate = audioBuffer.sampleRate;
  const start = Math.max(0, Math.floor(time * rate));
  const end = Math.min(audioBuffer.length, Math.ceil((time + windowSeconds) * rate));
  if (end <= start) return true; // past the end of the audio
  let sumSquares = 0;
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = start; i < end; i++) sumSquares += data[i] * data[i];
  }
  return Math.sqrt(sumSquares / ((end - start) * audioBuffer.numberOfChannels)) < threshold;
}

function toMono(audioBuffer) {
  const length = audioBuffer.length;
  const channels = audioBuffer.numberOfChannels;
  const mono = new Float32Array(length);
  for (let c = 0; c < channels; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < length; i++) mono[i] += data[i] / channels;
  }
  return mono;
}

export function analyzeSignal(signal, sampleRate, sampleInterval = 0.25) {
  const duration = signal.length / sampleRate;
  if (!(duration > 0)) throw new Error('Audio is empty.');
  const count = Math.ceil(duration / sampleInterval);
  const bandContext = createBandContext(sampleRate);

  // Stage A: measure each time slice (same time grid as makeFakeAudioFeatures).
  const times = [];
  const loudnessDb = [];
  const bandPower = [];
  for (let i = 0; i <= count; i++) {
    const time = Math.min(i * sampleInterval, duration);
    const start = Math.max(0, Math.floor((time - sampleInterval / 2) * sampleRate));
    const end = Math.min(signal.length, Math.ceil((time + sampleInterval / 2) * sampleRate));
    times.push(time);
    loudnessDb.push(Math.max(-60, 20 * Math.log10(windowRms(signal, start, end) + 1e-6))); // floor at -60 dB so silence doesn't stretch the scale
    bandPower.push(averageBandPower(signal, start, end, bandContext));
  }

  // Stage B: derive the contract features, then rescale each to 0..1 across the track.
  const volume = normalize(loudnessDb);
  // "Change" = how much louder than the previous slice. A rise is what makes beats and accents feel energetic.
  const rise = loudnessDb.map((db, i) => (i === 0 ? 0 : Math.max(0, db - loudnessDb[i - 1])));
  const accent = normalize(rise);
  const energy = volume.map((v, i) => clamp(0.7 * v + 0.3 * accent[i], 0, 1));
  const spectrum = bandPowerToUnitRange(bandPower);

  // Melody: the register of the sound (where the middle of the melody range sits, 0 = low .. 1 = high; octaves count
  // equally) and how clearly one band stands out (a clear melodic line versus a wash of sound).
  let lastPosition = 0.5;
  const melody = spectrum.map((row, i) => {
    if (loudnessDb[i] < -50) return { position: lastPosition, tonality: 0 };
    const shape = melodyShape(row);
    lastPosition = shape.position;
    return shape;
  });
  const pitch = normalize(melody.map(m => m.position));

  // Rhythm: the tempo as it changes through the song, how clearly the beat repeats, and where the beats fall.
  // A file with no clear tempo (speech, noise, ambient washes) gets none of these, and is driven at the default pace.
  const onsets = computeOnsetEnvelope(signal, sampleRate);
  const pulses = onsetPulses(onsets.envelope, onsets.fps);
  const rhythm = estimateTempoTrack(pulses, onsets.fps, duration, times);
  const tempoAt = t => rhythm.tempo[Math.min(times.length - 1, Math.round(t / sampleInterval))];

  const samples = times.map((time, i) => {
    const sample = { time, volume: volume[i], pitch: pitch[i], energy: energy[i], spectrum: spectrum[i], loudness: Math.round(loudnessDb[i] * 100) / 100 };
    sample.complexity = Math.round(spectralOccupancy(spectrum[i], loudnessDb[i]) * 1000) / 1000;
    sample.tonality = Math.round(melody[i].tonality * 1000) / 1000;
    sample.pulse = rhythm ? Math.round(rhythm.pulse[i] * 1000) / 1000 : 0;
    if (rhythm) sample.tempo = Math.round(rhythm.tempo[i] * 10) / 10;
    return sample;
  });
  const result = { duration, samples };
  if (rhythm) {
    const beats = trackBeats(pulses, onsets.fps, duration, tempoAt);
    result.beats = { time: beats.map(b => Math.round(b.time * 1000) / 1000), strength: beats.map(b => Math.round(b.strength * 1000) / 1000) };
  }
  return result;
}

function windowRms(signal, start, end) {
  let sumSquares = 0;
  for (let i = start; i < end; i++) sumSquares += signal[i] * signal[i];
  return end > start ? Math.sqrt(sumSquares / (end - start)) : 0;
}

// Rescale so the 5th..95th percentile of the track spans 0..1. Percentiles (instead of min/max)
// stop one loud click or silent gap from squashing everything else into a narrow band.
function normalize(values, lowPct = 0.05, highPct = 0.95) {
  const sorted = [...values].sort((a, b) => a - b);
  const lo = sorted[Math.floor(lowPct * (sorted.length - 1))];
  const hi = sorted[Math.floor(highPct * (sorted.length - 1))];
  const range = hi - lo;
  if (range < 1e-9) return values.map(() => 0.5); // constant signal: sit in the middle
  return values.map(v => clamp((v - lo) / range, 0, 1));
}

/* ------------------------------------------------------------------------- *
 * Spectrum: FFT -> power per frequency bin -> grouped into SPECTRUM_BANDS log-spaced bands
 * ------------------------------------------------------------------------- */

function createBandContext(sampleRate) {
  const hann = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  return {
    fft: createFFT(FFT_SIZE),
    hann,
    filters: createBandFilters(sampleRate, FFT_SIZE, SPECTRUM_BANDS, bandAxisToHz),
    re: new Float64Array(FFT_SIZE),
    im: new Float64Array(FFT_SIZE),
  };
}

// Average the band power of several FFT frames spread across [start, end).
function averageBandPower(signal, start, end, ctx) {
  const total = new Float64Array(SPECTRUM_BANDS);
  const span = Math.max(0, end - start);
  const frames = Math.max(1, Math.round(span / BAND_HOP));
  for (let f = 0; f < frames; f++) {
    const center = Math.floor(start + ((f + 0.5) / frames) * span);
    const first = center - FFT_SIZE / 2;
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = first + i;
      ctx.re[i] = idx >= 0 && idx < signal.length ? signal[idx] * ctx.hann[i] : 0;
      ctx.im[i] = 0;
    }
    ctx.fft(ctx.re, ctx.im);
    for (let b = 0; b < SPECTRUM_BANDS; b++) {
      const { start: k0, weights } = ctx.filters[b];
      let sum = 0;
      for (let j = 0; j < weights.length; j++) {
        const k = k0 + j;
        sum += weights[j] * (ctx.re[k] * ctx.re[k] + ctx.im[k] * ctx.im[k]);
      }
      total[b] += sum / frames;
    }
  }
  return total;
}

// Power -> decibels relative to the loudest band-moment of the track -> 0..1.
function bandPowerToUnitRange(bandPower) {
  let max = 0;
  for (const row of bandPower) for (let b = 0; b < row.length; b++) if (row[b] > max) max = row[b];
  if (max <= 0) return bandPower.map(row => Array.from(row, () => 0));
  return bandPower.map(row => Array.from(row, p => {
    const db = 10 * Math.log10(p / max + 1e-12);
    return round4(clamp((db + SPECTRUM_DB_RANGE) / SPECTRUM_DB_RANGE, 0, 1));
  }));
}

// Map a position p in [0, 1] along the band axis to a frequency. Each half is logarithmic, and the halfway
// point (p = 0.5) is exactly SPECTRUM_SPLIT_HZ. (A single log axis cannot put 8 kHz at its midpoint for audible
// frequencies, so the axis is two log segments joined at the split.)
export function bandAxisToHz(p) {
  return p < 0.5
    ? SPECTRUM_LOW_HZ * Math.pow(SPECTRUM_SPLIT_HZ / SPECTRUM_LOW_HZ, p / 0.5)
    : SPECTRUM_SPLIT_HZ * Math.pow(SPECTRUM_HIGH_HZ / SPECTRUM_SPLIT_HZ, (p - 0.5) / 0.5);
}

// Triangular filters evenly spaced along the warped band axis. Each filter's weights sum to 1, so a band is
// the *average* power of its bins and wide high-frequency bands don't look louder than narrow low ones.
function createBandFilters(sampleRate, fftSize, bands, axisToHz) {
  const edges = [];
  for (let i = 0; i < bands + 2; i++) edges.push(axisToHz(i / (bands + 1)));

  const binHz = sampleRate / fftSize;
  const lastBin = fftSize / 2;
  const filters = [];
  for (let b = 0; b < bands; b++) {
    const lo = edges[b], mid = edges[b + 1], hi = edges[b + 2];
    const firstBin = Math.max(0, Math.floor(lo / binHz));
    const endBin = Math.min(lastBin, Math.ceil(hi / binHz));
    const weights = [];
    let sum = 0;
    for (let k = firstBin; k <= endBin; k++) {
      const f = k * binHz;
      const w = f <= lo || f >= hi ? 0 : f < mid ? (f - lo) / (mid - lo) : (hi - f) / (hi - mid);
      weights.push(w);
      sum += w;
    }
    if (sum <= 0) {
      // Band narrower than one FFT bin: just use the nearest bin.
      filters.push({ start: Math.min(lastBin, Math.round(mid / binHz)), weights: [1] });
    } else {
      filters.push({ start: firstBin, weights: weights.map(w => w / sum) });
    }
  }
  return filters;
}

/* ------------------------------------------------------------------------- *
 * Rhythm: onset envelope -> tempo (BPM) over time
 * ------------------------------------------------------------------------- */

const ONSET_FFT = 1024;       // ~23 ms frames...
const ONSET_HOP = 512;        // ...every ~11.6 ms
const ONSET_BANDS = 24;
const TEMPO_RANGE = [70, 160]; // BPM. Narrow enough that half/double-time can rarely both fit, so no folding is needed.
const TEMPO_WINDOW = 8;       // seconds of music examined per estimate
const TEMPO_STEP = 1;         // seconds between estimates
const MIN_ONSET_LEVEL = 0.25; // average dB of new sound per band per frame below which a held tone or drone has no onsets at all
const MIN_CLEAR_SHARE = 0.5;  // a file has a tempo only if at least this share of it has a clear beat
const MIN_PULSE = 0.3;        // how strongly the beat must repeat to count; steadier than this is a beat, less is just texture

// "How much new sound just started?" at ~86 frames per second: the sum of increases in each frequency band.
function computeOnsetEnvelope(signal, sampleRate) {
  const fps = sampleRate / ONSET_HOP;
  const frames = Math.floor((signal.length - ONSET_FFT) / ONSET_HOP) + 1;
  if (frames < 16) return { envelope: new Float32Array(0), fps };
  const fft = createFFT(ONSET_FFT);
  const hann = new Float64Array(ONSET_FFT);
  for (let i = 0; i < ONSET_FFT; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (ONSET_FFT - 1));
  const filters = createBandFilters(sampleRate, ONSET_FFT, ONSET_BANDS, p => 50 * Math.pow(200, p)); // 50 Hz - 10 kHz
  const re = new Float64Array(ONSET_FFT), im = new Float64Array(ONSET_FFT);
  const db = new Float32Array(frames * ONSET_BANDS);
  let maxDb = -Infinity;
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < ONSET_FFT; i++) { re[i] = signal[f * ONSET_HOP + i] * hann[i]; im[i] = 0; }
    fft(re, im);
    for (let b = 0; b < ONSET_BANDS; b++) {
      const { start, weights } = filters[b];
      let sum = 0;
      for (let j = 0; j < weights.length; j++) sum += weights[j] * (re[start + j] * re[start + j] + im[start + j] * im[start + j]);
      const v = 10 * Math.log10(sum + 1e-12);
      db[f * ONSET_BANDS + b] = v;
      if (v > maxDb) maxDb = v;
    }
  }
  const floor = maxDb - 70; // ignore anything more than 70 dB below the loudest moment (noise floor)
  const envelope = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    let flux = 0;
    for (let b = 0; b < ONSET_BANDS; b++) flux += Math.max(0, Math.max(floor, db[f * ONSET_BANDS + b]) - Math.max(floor, db[(f - 1) * ONSET_BANDS + b]));
    envelope[f] = flux / ONSET_BANDS;
  }
  return { envelope, fps };
}

// Keep only the pulses of an onset envelope: subtract a ~0.8 s moving average so slow swells don't look like rhythm.
function onsetPulses(envelope, fps) {
  const total = envelope.length, half = Math.round(0.4 * fps);
  const prefix = new Float64Array(total + 1);
  for (let i = 0; i < total; i++) prefix[i + 1] = prefix[i] + envelope[i];
  const pulses = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const lo = Math.max(0, i - half), hi = Math.min(total, i + half + 1);
    pulses[i] = Math.max(0, envelope[i] - (prefix[hi] - prefix[lo]) / (hi - lo));
  }
  return pulses;
}

// Tempo (BPM) and pulse clarity (0..1) at each of `times`, or null if the file has no clear tempo.
// A steady beat makes the pulses repeat every beat-length, which shows up as a peak when they are compared with a
// delayed copy of themselves. For each stretch of music, the strongest such delay in range is the beat. A file only
// counts as having a tempo if MOST of it has a clear beat; speech, noise and ambient washes don't, and are left alone.
function estimateTempoTrack(pulses, fps, duration, times) {
  const total = pulses.length;
  const window = Math.min(total, Math.round(TEMPO_WINDOW * fps));
  if (total < fps * 4) return null;
  const lagMin = Math.floor((fps * 60) / TEMPO_RANGE[1]);
  const lagMax = Math.ceil((fps * 60) / TEMPO_RANGE[0]);

  const steps = Math.floor(duration / TEMPO_STEP) + 1;
  const logBpm = new Array(steps).fill(NaN);
  const clarity = new Array(steps).fill(0);
  for (let k = 0; k < steps; k++) {
    const start = Math.max(0, Math.min(total - window, Math.round(k * TEMPO_STEP * fps - window / 2)));
    let mean = 0;
    for (let i = start; i < start + window; i++) mean += pulses[i];
    mean /= window;
    let variance = 0;
    for (let i = start; i < start + window; i++) variance += (pulses[i] - mean) ** 2;
    variance /= window;
    if (variance < 1e-9 || mean < MIN_ONSET_LEVEL) continue; // silence, or only held sound: no onsets to keep time with
    let best = 0, bestR = 0;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let r = 0;
      for (let i = start; i + lag < start + window; i++) r += (pulses[i] - mean) * (pulses[i + lag] - mean);
      r /= (window - lag) * variance;                                              // 1 = perfectly repeating, 0 = no pattern
      if (r > bestR) { bestR = r; best = lag; }
    }
    clarity[k] = Math.min(1, bestR);
    if (best && bestR >= MIN_PULSE) logBpm[k] = Math.log2((fps * 60) / best);
  }
  if (logBpm.filter(v => !Number.isNaN(v)).length < MIN_CLEAR_SHARE * steps) return null; // no clear tempo: use the default pace

  // The occasional stretch without a clear beat borrows the nearest answer.
  let last = logBpm.find(v => !Number.isNaN(v));
  for (let k = 0; k < steps; k++) { if (Number.isNaN(logBpm[k])) logBpm[k] = last; else last = logBpm[k]; }

  const smoothBpm = gaussianSmoothArray(logBpm, 2); // ~2 s: the tempo may change, but the speed shouldn't jolt
  const smoothClarity = gaussianSmoothArray(clarity, 2);
  const at = (arr, t) => { const p = Math.min(steps - 1, t / TEMPO_STEP), i = Math.floor(p), f = p - i; return arr[i] * (1 - f) + arr[Math.min(steps - 1, i + 1)] * f; };
  return { tempo: Float64Array.from(times, t => Math.pow(2, at(smoothBpm, t))), pulse: Float64Array.from(times, t => at(smoothClarity, t)) };
}

// Follow the beat through the song: each beat is expected one tempo-period after the last, then nudged toward the
// strongest onset nearby, so the beats stay on the music's real hits even as the tempo drifts.
function trackBeats(pulses, fps, duration, tempoAt) {
  const at = t => pulses[Math.min(pulses.length - 1, Math.max(0, Math.round(t * fps)))];
  const strongest = (from, to) => {
    let best = Math.max(0, from), value = -1;
    for (let t = Math.max(0, from); t <= to; t += 1 / fps) if (at(t) > value) { value = at(t); best = t; }
    return best;
  };
  const beats = [];
  let t = strongest(0, 60 / tempoAt(0));
  while (t < duration) {
    beats.push({ time: t, strength: at(strongest(t - 0.06, t + 0.06)) });
    const period = 60 / tempoAt(t), expected = t + period;
    t = expected + 0.5 * (strongest(expected - 0.2 * period, expected + 0.2 * period) - expected);
  }
  return beats;
}

// The melody range (about 200 Hz to 4 kHz): where the middle of the sound sits in it (0 = low, 1 = high), and how many
// dB the strongest band stands above the average band (a clear melodic line stands out; a wash of sound does not).
const MID_BANDS = Array.from({ length: SPECTRUM_BANDS }, (_, b) => b).filter(b => {
  const hz = bandAxisToHz((b + 1) / (SPECTRUM_BANDS + 1));
  return hz >= 200 && hz <= 4000;
});
function melodyShape(spectrum) {
  let sum = 0, weighted = 0, peak = 0;
  MID_BANDS.forEach((b, k) => {
    const power = Math.pow(10, (spectrum[b] - 1) * (SPECTRUM_DB_RANGE / 10)); // the spectrum is 0..1 over an 80 dB range
    sum += power; weighted += power * k; peak = Math.max(peak, power);
  });
  if (sum <= 0) return { position: 0.5, tonality: 0 };
  return { position: weighted / sum / (MID_BANDS.length - 1), tonality: clamp((10 * Math.log10((peak * MID_BANDS.length) / sum)) / 12, 0, 1) };
}

// How much of the frequency range is in use: the share of bands within ACTIVE_DB of the loudest band.
// One pure tone lights up a couple of bands; a dense full-band mix lights up most of them.
const ACTIVE_DB = 24;
function spectralOccupancy(spectrum, loudnessDb) {
  if (loudnessDb < -50) return 0; // silence has no content, however flat its noise floor looks
  const limit = Math.max(...spectrum) - ACTIVE_DB / SPECTRUM_DB_RANGE;
  let active = 0;
  for (const v of spectrum) if (v >= limit) active++;
  return active / spectrum.length;
}

function gaussianSmoothArray(values, sigma) {
  const radius = Math.ceil(3 * sigma);
  const kernel = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) { const w = Math.exp(-0.5 * (i / sigma) ** 2); kernel.push(w); sum += w; }
  return values.map((_, i) => {
    let acc = 0;
    for (let j = -radius; j <= radius; j++) acc += kernel[j + radius] * values[Math.min(values.length - 1, Math.max(0, i + j))];
    return acc / sum;
  });
}

// Standard iterative radix-2 FFT, in place. `re`/`im` hold the real/imaginary parts.
function createFFT(n) {
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const bits = Math.round(Math.log2(n));
  const reversed = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    reversed[i] = r;
  }
  return (re, im) => {
    for (let i = 0; i < n; i++) {
      const j = reversed[i];
      if (j > i) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * cos[k] + im[l] * sin[k];
          const tim = -re[l] * sin[k] + im[l] * cos[k];
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  };
}

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function round4(v) { return Math.round(v * 10000) / 10000; }
