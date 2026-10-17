// Token bucket per platform and account, so the publish workers stay inside X's windows instead
// of finding them by hitting 429. Redis when there are several workers; memory for one.

import { Redis } from "ioredis";

export type Take = { ok: true } | { ok: false; retryAt: Date };

export interface RateBucket {
  take(key: string): Promise<Take>;
  close(): Promise<void>;
}

export class MemoryBucket implements RateBucket {
  private readonly state = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly capacity: number, private readonly windowSeconds: number, private readonly now = () => Date.now()) {}

  async take(key: string): Promise<Take> {
    const rate = this.capacity / (this.windowSeconds * 1000);
    const t = this.now();
    const s = this.state.get(key) ?? { tokens: this.capacity, at: t };
    const tokens = Math.min(this.capacity, s.tokens + (t - s.at) * rate);
    if (tokens >= 1) {
      this.state.set(key, { tokens: tokens - 1, at: t });
      return { ok: true };
    }
    this.state.set(key, { tokens, at: t });
    return { ok: false, retryAt: new Date(t + Math.ceil((1 - tokens) / rate)) };
  }

  async close(): Promise<void> {}
}

// Refill and take in one atomic step. Returns ms to wait (0 = taken).
const TAKE = `
local key, capacity, rate, now = KEYS[1], tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local s = redis.call('HMGET', key, 'tokens', 'at')
local tokens = tonumber(s[1]) or capacity
local at = tonumber(s[2]) or now
tokens = math.min(capacity, tokens + (now - at) * rate)
local wait = 0
if tokens >= 1 then tokens = tokens - 1 else wait = math.ceil((1 - tokens) / rate) end
redis.call('HSET', key, 'tokens', tokens, 'at', now)
redis.call('PEXPIRE', key, math.ceil(capacity / rate) * 2)
return wait`;

export class RedisBucket implements RateBucket {
  private readonly redis: Redis;

  constructor(url: string, private readonly capacity: number, private readonly windowSeconds: number) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 2 });
  }

  async take(key: string): Promise<Take> {
    const rate = this.capacity / (this.windowSeconds * 1000);
    const now = Date.now();
    const wait = Number(await this.redis.eval(TAKE, 1, `socia:bucket:${key}`, this.capacity, rate, now));
    return wait === 0 ? { ok: true } : { ok: false, retryAt: new Date(now + wait) };
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
