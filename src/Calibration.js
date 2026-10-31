/**
 * A memory of the files this browser has analyzed, so the biome map spreads itself evenly over whatever music you actually
 * load. Fixed thresholds can't suit every library, so each decision point here is a sensible default pulled toward the
 * library's own quantiles as it grows (the first few files use the defaults; from about twelve files on, the library decides):
 *
 *   temperature  cut points at the library's terciles (cold / mild / hot)
 *   moisture     cut points among the library files of the SAME temperature band, so each of the nine cells gets about a
 *                ninth of the files whatever the relationship between temperature and moisture
 *   mountains    the widest-hilled tenth of files
 *   night        files quieter than a fixed absolute level (not learned from the library)
 *
 * The readings themselves (the four temperature cues, the sustain) stay on fixed physical scales; only the cut points move.
 * A file's biome can therefore shift as the library grows. `reset()` forgets everything.
 */
const KEY = 'audio-world.calibration.v1';
const MAX_FILES = 300;    // how many files are remembered
const RAMP = 12;          // the defaults stand in for the library until this many files have been seen
// Set to false to stop learning from the library and use DEFAULTS alone (e.g. once you have pasted in cutoffs from report()).
export const LEARN_FROM_LIBRARY = true;

// Starting cutoffs, ESTIMATED from published figures for typical music (loudness by genre and era, loudness range, and the near-pink
// average spectrum of music) plus two measured tracks. They are not measured from a large library, so treat them as informed
// guesses; the library (below) refines them as you use the app.
export const DEFAULTS = {
  // Raw warmth, 0..1. Typical music averages about 0.57 with a spread near 0.12, so terciles fall near 0.52 and 0.63.
  temperatureCuts: [0.52, 0.63],
  // Moisture for the cold, mild and hot bands. Bright music is usually also loud and sustained (wetter); dark, old or
  // classical recordings are usually more dynamic (drier), so the cold band's cuts sit higher and the hot band's lower.
  moistureCuts: [[0.55, 0.78], [0.44, 0.70], [0.38, 0.62]],
  // Hill range grows with loudness range: about 6 LU for rock and pop, 10 for ballads, 15 to 25 for classical. The widest
  // tenth of a mixed library is the classical and the most dynamic stage and screen music, at roughly 33 and up.
  mountainSpread: 33,
  // Night: average loudness plus 10 dB x beat clarity (see BIOME_CHOICE.activityDb). Rock and pop sit near -22 to -15 with a
  // clear beat (scoring above -18); a beatless ballad or classical piece scores about -23 and below.
  nightLevel: -20,
};

export function createCalibration(storage = globalThis.localStorage) {
  let seen = [];
  try { seen = JSON.parse(storage?.getItem(KEY) ?? '[]'); } catch { seen = []; }
  const save = () => { try { storage?.setItem(KEY, JSON.stringify(seen)); } catch { /* storage full or unavailable: carry on without remembering */ } };

  const quantile = (values, q) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(q * (sorted.length - 1))]; };
  // The default, handed over to the library's own value over the first few files. (It must hand over completely: a default
  // that lingers pulls a narrow library, whose whole spread may be tiny, off balance.)
  const blend = (fallback, values, q) => {
    if (!LEARN_FROM_LIBRARY || !values.length) return fallback;
    const w = Math.min(1, values.length / RAMP);
    return (1 - w) * fallback + w * quantile(values, q);
  };

  // Mountains are decided first, and (being the files with the widest dynamics, which also read as dry) they take a
  // lopsided share of some cells, so the temperature and moisture cut points are learned from the rest of the files only.
  const grid = () => seen.filter(o => !o.mountain);
  const temperatureCuts = () => {
    const ts = grid().map(o => o.t);
    return [blend(DEFAULTS.temperatureCuts[0], ts, 1 / 3), blend(DEFAULTS.temperatureCuts[1], ts, 2 / 3)];
  };
  const bandOf = t => { const [c1, c2] = temperatureCuts(); return t < c1 ? 0 : t < c2 ? 1 : 2; };

  return {
    count: () => seen.length,
    temperatureCuts,
    moistureCuts(band) {
      const ms = grid().filter(o => bandOf(o.t) === band).map(o => o.m);
      return [blend(DEFAULTS.moistureCuts[band][0], ms, 1 / 3), blend(DEFAULTS.moistureCuts[band][1], ms, 2 / 3)];
    },
    mountainSpread: () => blend(DEFAULTS.mountainSpread, seen.map(o => o.spread), 0.9),
    nightLevel: () => DEFAULTS.nightLevel, // night is for music that is quiet in absolute terms, whatever else you have loaded
    // Remember a file (a file already remembered isn't counted twice).
    record(obs) {
      if (seen.some(o => Math.abs(o.t - obs.t) < 1e-6 && Math.abs(o.m - obs.m) < 1e-6 && Math.abs(o.level - obs.level) < 1e-6)) return;
      seen.push(obs);
      if (seen.length > MAX_FILES) seen.shift();
      save();
    },
    // Print every remembered file's readings, and the cutoffs that would split THIS library evenly, ready to paste into DEFAULTS
    // above (then set LEARN_FROM_LIBRARY to false to make them fixed). Temperature is the raw warmth, before night's allowance.
    report(activityDb = 10) {
      console.table(seen.map(o => ({
        file: o.name ?? '', warmth: o.warmth?.toFixed(3), moisture: o.m.toFixed(3), hills: o.spread.toFixed(1),
        loudness: o.level.toFixed(1), beat: o.activity?.toFixed(2), mountain: !!o.mountain,
      })));
      const rest = seen.filter(o => !o.mountain && o.warmth != null);
      const tCuts = [quantile(rest.map(o => o.warmth), 1 / 3), quantile(rest.map(o => o.warmth), 2 / 3)];
      const band = w => (w < tCuts[0] ? 0 : w < tCuts[1] ? 1 : 2);
      const mCuts = [0, 1, 2].map(b => { const ms = rest.filter(o => band(o.warmth) === b).map(o => o.m); return [quantile(ms, 1 / 3), quantile(ms, 2 / 3)]; });
      const fmt = v => (v == null ? 'n/a' : +v.toFixed(3));
      const scores = seen.filter(o => o.activity != null).map(o => o.level + activityDb * o.activity);
      console.info(`[calibration] suggested cutoffs from ${seen.length} files (${rest.length} not mountains):
  temperatureCuts: [${tCuts.map(fmt)}],
  moistureCuts: [${mCuts.map(m => `[${m.map(fmt)}]`)}],
  mountainSpread: ${fmt(quantile(seen.map(o => o.spread), 0.9))},      // widest-hilled tenth
  nightLevel: ${fmt(quantile(scores, 0.3))},          // quietest, calmest third (level + ${activityDb} x beat clarity)`);
    },
    reset() { seen = []; try { storage?.removeItem(KEY); } catch { /* nothing to forget */ } },
  };
}
