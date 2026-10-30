/**
 * The road is laid out in BEATS: every beat of the song is DRIVE.unitsPerBeat world units long.
 * So the driving speed is simply  unitsPerBeat * tempo / 60  (faster tempo = faster drive), and everything
 * built along the road (hills, biomes) stretches by that same one number.
 * A song with no detectable beat is driven at DRIVE.defaultBpm.
 */
export const DRIVE = {
  unitsPerBeat: 7,   // ~12 units/s at 100 BPM: roughly a slow car drive if one unit is a meter
  defaultBpm: 100,
};

// Builds the mapping between song time and position on the road.
export function createTimeline(features) {
  const { samples } = features;
  const n = samples.length;
  const times = Float64Array.from(samples, s => s.time);
  const speeds = Float64Array.from(samples, s => (DRIVE.unitsPerBeat * (s.tempo || DRIVE.defaultBpm)) / 60);
  const distance = new Float64Array(n); // distance[i] = road position at times[i]
  for (let i = 1; i < n; i++) distance[i] = distance[i - 1] + ((speeds[i] + speeds[i - 1]) / 2) * (times[i] - times[i - 1]);

  // Position of x in the increasing array `xs`, as an interpolated index.
  function lookup(xs, x) {
    if (x <= xs[0]) return 0;
    if (x >= xs[n - 1]) return n - 1;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid; else hi = mid;
    }
    return lo + (x - xs[lo]) / (xs[hi] - xs[lo]);
  }
  const blend = (arr, p) => { const i = Math.floor(p); return i >= n - 1 ? arr[n - 1] : arr[i] + (arr[i + 1] - arr[i]) * (p - i); };

  return {
    length: distance[n - 1],
    distance,                                   // road position at each sample time
    timeAt: z => blend(times, lookup(distance, z)),
    zAt: t => blend(distance, lookup(times, t)),
    speedAt: t => blend(speeds, lookup(times, t)),
  };
}

export function attachTimeline(features) {
  return { ...features, timeline: createTimeline(features) };
}

// Song time at road position z. (Without a timeline, assume the old fixed layout: the song spread over 620 units.)
export function timeAtZ(features, z) {
  if (features.timeline) return features.timeline.timeAt(z);
  return Math.min(1, Math.max(0, z / 620)) * features.duration;
}
