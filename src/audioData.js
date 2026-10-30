/**
 * Fake, normalized audio features used until the audio-analysis teammate is ready.
 * Replace makeFakeAudioFeatures() with the real feature extractor's output later.
 * Contract: { duration: seconds, samples: [{ time, volume, pitch, energy }] }
 * Every feature is expected to be normalized to [0, 1].
 */
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
    samples.push({ time, volume, pitch, energy });
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

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
