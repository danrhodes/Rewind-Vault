/** Small, fast seeded PRNG (mulberry32): the same seed always gives the same sequence in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Choose about `pct` percent of `items` at random (at least one when `items` is not empty;
 * everything for 100 or more). The input is sorted first so the pick depends only on the
 * set of items and the random sequence, never on the order they were listed in.
 */
export function pickSample(
  items: readonly string[],
  pct: number,
  random: () => number,
): Set<string> {
  if (items.length === 0) return new Set();
  if (pct >= 100) return new Set(items);
  const count = Math.min(items.length, Math.max(1, Math.ceil((items.length * pct) / 100)));
  const pool = [...items].sort();
  // Partial Fisher-Yates: only the first `count` positions need to be settled.
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    const tmp = pool[i] as string;
    pool[i] = pool[j] as string;
    pool[j] = tmp;
  }
  return new Set(pool.slice(0, count));
}
