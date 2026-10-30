/**
 * Audio features for the world generators.
 *
 * Contract: { duration: seconds, samples: [{ time, volume, pitch, energy, spectrum }] }
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
const SPECTRUM_DB_RANGE = 80; // dB below the track's loudest moment that maps to 0

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
    samples.push({ time, volume, pitch, energy, spectrum });
  }
  return { duration, samples };
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

  return {
    volume: lerp(a.volume, b.volume, f),
    pitch: lerp(a.pitch, b.pitch, f),
    energy: lerp(a.energy, b.energy, f),
  };
}

/* ------------------------------------------------------------------------- *
 * Real audio analysis
 *
 * Two stages, so each can be tested on its own:
 *   1. makeAudioFeatures(file)  - browser-only: File -> decoded audio -> raw numbers
 *   2. analyzeSignal(...)       - pure math: raw numbers -> features object
 * ------------------------------------------------------------------------- */

export async function makeAudioFeatures(file, sampleInterval = 0.25) {
  const arrayBuffer = await file.arrayBuffer();
  // An OfflineAudioContext decodes audio without playing it (and without needing a click).
  const ctx = new OfflineAudioContext(1, 1, ANALYSIS_RATE);
  let audioBuffer;
  try {
    audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  } catch {
    throw new Error(`Couldn't decode "${file.name}". Try a .wav or .mp3 file.`);
  }
  return analyzeSignal(toMono(audioBuffer), audioBuffer.sampleRate, sampleInterval);
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
  const frequencyHz = [];
  const bandPower = [];
  let lastFrequency = 0;
  for (let i = 0; i <= count; i++) {
    const time = Math.min(i * sampleInterval, duration);
    const start = Math.max(0, Math.floor((time - sampleInterval / 2) * sampleRate));
    const end = Math.min(signal.length, Math.ceil((time + sampleInterval / 2) * sampleRate));
    const { rms, crossings } = measureWindow(signal, start, end);

    const windowSeconds = (end - start) / sampleRate;
    const isSilent = rms < 0.001 || windowSeconds <= 0;
    // A pure tone crosses zero twice per cycle, so crossings / 2 / seconds ~ frequency in Hz.
    // In silence the count is just noise, so hold the previous value instead.
    const frequency = isSilent ? lastFrequency : crossings / 2 / windowSeconds;
    lastFrequency = frequency;

    times.push(time);
    loudnessDb.push(Math.max(-60, 20 * Math.log10(rms + 1e-6))); // floor at -60 dB so silence doesn't stretch the scale
    frequencyHz.push(frequency);
    bandPower.push(averageBandPower(signal, start, end, bandContext));
  }

  // Stage B: derive the contract features, then rescale each to 0..1 across the track.
  const volume = normalize(loudnessDb);
  const pitch = normalize(frequencyHz.map(f => Math.log2(Math.max(f, 20)))); // log: octaves are equal steps
  // "Change" = how much louder than the previous slice. A rise is what makes beats and accents feel energetic.
  const rise = loudnessDb.map((db, i) => (i === 0 ? 0 : Math.max(0, db - loudnessDb[i - 1])));
  const accent = normalize(rise);
  const energy = volume.map((v, i) => clamp(0.7 * v + 0.3 * accent[i], 0, 1));
  const spectrum = bandPowerToUnitRange(bandPower);

  const samples = times.map((time, i) => ({
    time, volume: volume[i], pitch: pitch[i], energy: energy[i], spectrum: spectrum[i],
  }));
  return { duration, samples };
}

function measureWindow(signal, start, end) {
  let sumSquares = 0;
  let crossings = 0;
  for (let i = start; i < end; i++) {
    sumSquares += signal[i] * signal[i];
    if (i > start && (signal[i] < 0) !== (signal[i - 1] < 0)) crossings++;
  }
  const n = end - start;
  return { rms: n > 0 ? Math.sqrt(sumSquares / n) : 0, crossings };
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
    filters: createBandFilters(sampleRate, FFT_SIZE),
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
function createBandFilters(sampleRate, fftSize) {
  const bands = SPECTRUM_BANDS;
  const edges = [];
  for (let i = 0; i < bands + 2; i++) edges.push(bandAxisToHz(i / (bands + 1)));

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
