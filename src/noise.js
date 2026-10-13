// Small deterministic value-noise implementation with smooth interpolation.
export function createNoise(seed = 1) {
  const hash = (x, z) => {
    let n = (x * 374761393 + z * 668265263 + seed * 1442695041) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    n ^= n >>> 16;
    return (n >>> 0) / 4294967295;
  };
  const smooth = t => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  return (x, z) => {
    const x0 = Math.floor(x), z0 = Math.floor(z);
    const fx = smooth(x - x0), fz = smooth(z - z0);
    const a = lerp(hash(x0, z0), hash(x0 + 1, z0), fx);
    const b = lerp(hash(x0, z0 + 1), hash(x0 + 1, z0 + 1), fx);
    return lerp(a, b, fz) * 2 - 1;
  };
}
