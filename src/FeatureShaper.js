import { attachTimeline } from './Timeline.js';

/**
 * Turns raw features into world-ready ones.
 *
 * Terrain height comes straight from the song's loudness (quiet = low, loud = high): every dB above or below the song's
 * typical level raises or lowers the ground by SHAPING.heightPerDb, and the original volume-to-height rule and the file's
 * overall loudness are added on top. Nothing is rescaled to a benchmark, so a song with big dynamics
 * (silence between hits, loud choruses) gets big hills and a steady one gets gentle ground.
 *
 * Raw loudness jumps far faster than real ground could, so one physical rule is applied: the ground's
 * height may not be steeper than a maximum slope. Slow swings pass through untouched; fast flickers shrink to small
 * bumps. That is what separates realistic terrain from spikes. Pitch, energy and complexity (which steer the road's
 * bends and the scenery) are simply blurred, so the road has no sharp corners.
 */
export const SHAPING = {
  heightPerDb: 1.0,       // world units of height per dB of loudness
  centerHeight: 18,       // height of a song's typical loudness
  minHeight: 1.5,
  maxHeight: 60,          // how high the ground may rise
  maxHillSlope: 1.1,      // steepest allowed ground, in height units per world unit
  featureSmooth: 12,      // world units of smoothing for pitch, energy and complexity, so the road's bends have no sharp corners
  salienceSmooth: 120,    // world units over which "how clear is the melody / the beat" is averaged, so the road's roles swap slowly
  // The original design, kept alongside the dB term above: quiet audio is low terrain, loud audio higher terrain.
  legendHeight: 16,       // within a file, the quietest stretches sit this much lower than the loudest (centered on centerHeight)
  levelHeight: 12,        // and a file that is loud overall sits higher than one that is quiet: -6 to +6 around centerHeight
  quietDb: -40, loudDb: -10, // overall loudness (dBFS) that counts as "quiet" and as "loud" for levelHeight
};

// Adds the timeline, blurs the features that steer the road, and (for real audio, which has `loudness`) turns
// loudness into terrain height. The demo data's heights are already tuned, so they are left alone.
export function prepareFeatures(features) {
  const withTimeline = attachTimeline(features);
  const { samples, timeline } = withTimeline;
  if (samples.length < 3) return withTimeline;

  const spacing = samples.map((_, i) => (i ? timeline.distance[i] - timeline.distance[i - 1] : 0)); // world units between samples
  const sigma = SHAPING.featureSmooth / (timeline.length / (samples.length - 1));                     // blur width in samples
  const pitch = gaussianSmooth(samples.map(s => s.pitch), sigma);
  const energy = gaussianSmooth(samples.map(s => s.energy), sigma);
  const complexity = gaussianSmooth(samples.map(s => s.complexity ?? s.energy), sigma);

  // How prominent the melody and the rhythm are along the road, each judged against this file's own range. These decide
  // which of the two steers the road's yaw and which its pitch (see RoadGenerator).
  const salienceSigma = SHAPING.salienceSmooth / (timeline.length / (samples.length - 1));
  const hasBeats = samples.some(s => s.pulse > 0);
  const melodySay = gaussianSmooth(rank(samples.map(s => s.tonality ?? 0.5), 0.5), salienceSigma);
  const rhythmSay = hasBeats ? gaussianSmooth(rank(samples.map(s => s.pulse), 0), salienceSigma) : samples.map(() => 0);

  // The beats, placed along the road (a beat is a fixed number of road units long, so the beats are evenly spread
  // except where the tempo changes), each with its strength relative to the other beats.
  let beatsZ = null;
  if (features.beats?.time.length) {
    const strength = rank(features.beats.strength, 0.5);
    beatsZ = { z: Float64Array.from(features.beats.time, t => timeline.zAt(t)), strength: Float64Array.from(strength, v => 0.3 + 0.7 * v) };
  }

  let relief = samples.map(s => s.relief);
  if (samples[0].loudness !== undefined) {
    const typical = median(samples.map(s => s.loudness));
    // How loud the file is overall (loud files sit higher), and, within the file, each moment's loudness rank (the original
    // rule: volume 0 = low ground, volume 1 = high ground, with the original 1.55 curve).
    const sound = samples.filter(s => s.loudness > -50);
    const overall = sound.length ? sound.reduce((a, s) => a + s.loudness, 0) / sound.length : SHAPING.quietDb;
    const level = clamp((overall - SHAPING.quietDb) / (SHAPING.loudDb - SHAPING.quietDb), 0, 1);
    const height = samples.map(s => clamp(
      SHAPING.centerHeight + SHAPING.heightPerDb * (s.loudness - typical)
        + SHAPING.legendHeight * (Math.pow(s.volume, 1.55) - 0.4) + SHAPING.levelHeight * (level - 0.5),
      SHAPING.minHeight, SHAPING.maxHeight));
    relief = limitSlope(height, spacing, SHAPING.maxHillSlope);
  }
  return { ...withTimeline, beatsZ, samples: samples.map((s, i) => ({ ...s, relief: relief[i], pitch: pitch[i], energy: energy[i], complexity: complexity[i], melodySay: melodySay[i], rhythmSay: rhythmSay[i] })) };
}

// The steepest-allowed version of `values`. `spacing[i]` is the distance between sample i-1 and i.
// Take the highest curve that never drops faster than `maxSlope` and the lowest that never rises faster, then
// average them: both obey the slope limit, so the average does too, and it treats peaks and valleys alike.
export function limitSlope(values, spacing, maxSlope) {
  const n = values.length;
  const upper = Float64Array.from(values), lower = Float64Array.from(values);
  for (let i = 1; i < n; i++) {
    const step = maxSlope * spacing[i];
    upper[i] = Math.max(upper[i], upper[i - 1] - step);
    lower[i] = Math.min(lower[i], lower[i - 1] + step);
  }
  for (let i = n - 2; i >= 0; i--) {
    const step = maxSlope * spacing[i + 1];
    upper[i] = Math.max(upper[i], upper[i + 1] - step);
    lower[i] = Math.min(lower[i], lower[i + 1] + step);
  }
  return Array.from(upper, (u, i) => (u + lower[i]) / 2);
}

// Rescale so the 5th..95th percentile of `values` spans 0..1; `flat` is returned if they are all the same.
function rank(values, flat) {
  const sorted = [...values].sort((a, b) => a - b);
  const lo = sorted[Math.floor(0.05 * (sorted.length - 1))], hi = sorted[Math.floor(0.95 * (sorted.length - 1))];
  return values.map(v => (hi - lo < 1e-6 ? flat : clamp((v - lo) / (hi - lo), 0, 1)));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function gaussianSmooth(values, sigma) {
  if (sigma < 0.3) return values.slice();
  const radius = Math.ceil(3 * sigma), kernel = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) { const w = Math.exp(-0.5 * (i / sigma) ** 2); kernel.push(w); sum += w; }
  const last = values.length - 1;
  return values.map((_, i) => {
    let acc = 0;
    for (let j = -radius; j <= radius; j++) acc += kernel[j + radius] * values[Math.min(last, Math.max(0, i + j))];
    return acc / sum;
  });
}
