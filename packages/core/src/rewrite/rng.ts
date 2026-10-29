// A small seeded random source: the same seed always makes the same choices (tests), a new seed new ones.
// Not for anything secret.

/** 32-bit hash of a string (cyrb53's mixing, low half) */
export function hashSeed(seed: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < seed.length; i++) {
    const ch = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  return h1 >>> 0;
}

export interface Rng {
  /** 0 <= x < 1 */
  next(): number;
  /** 0 <= n < max */
  int(max: number): number;
  pick<T>(list: readonly T[]): T;
  chance(p: number): boolean;
  /** A shuffled copy */
  shuffle<T>(list: readonly T[]): T[];
}

/** mulberry32 seeded from the string */
export function seededRng(seed: string): Rng {
  let state = hashSeed(seed);
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (max: number) => Math.floor(next() * max);
  return {
    next,
    int,
    pick: <T>(list: readonly T[]) => list[int(list.length)]!,
    chance: (p: number) => next() < p,
    shuffle: <T>(list: readonly T[]) => {
      const out = [...list];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
  };
}
