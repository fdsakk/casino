/* ============================================================================
   Redis Token Bucket — atomic per-key rate limiting via Lua

   Bucket holds up to `capacity` tokens. Each successful `consume()` removes
   `cost` tokens. Refill happens lazily on each call based on elapsed time
   and `refillPerSec`. Lua script ensures atomic read-modify-write — safe
   under concurrent requests for the same key.

   Storage: hash at `tb:{key}` with fields { tokens, ts }. TTL keeps inactive
   buckets from accumulating in Redis.
   ============================================================================ */

import { getRedis } from "./redis";

const LUA_CONSUME = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerSec = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local nowMs = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local data = redis.call("HMGET", key, "tokens", "ts")
local tokens = tonumber(data[1])
local ts = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  ts = nowMs
end

local elapsed = math.max(0, nowMs - ts) / 1000.0
tokens = math.min(capacity, tokens + elapsed * refillPerSec)

local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end

redis.call("HMSET", key, "tokens", tokens, "ts", nowMs)
redis.call("PEXPIRE", key, ttl)

local retryMs = 0
if allowed == 0 then
  local need = cost - tokens
  retryMs = math.ceil((need / refillPerSec) * 1000)
end

return { allowed, retryMs, tokens }
`;

export interface TokenBucketConfig {
  capacity: number;
  refillPerSec: number;
  cost?: number;
  prefix: string;
}

export interface ConsumeResult {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
}

/**
 * Atomic token-bucket consume using a Redis Lua script (server-side, atomic).
 * Fails open on Redis errors — the rate limiter is a safeguard, not a
 * correctness primitive (the atomic balance UPDATE prevents overspend).
 */
export async function consumeToken(
  key: string,
  cfg: TokenBucketConfig,
): Promise<ConsumeResult> {
  const cost = cfg.cost ?? 1;
  const ttlMs = Math.max(
    10_000,
    Math.ceil((cfg.capacity / cfg.refillPerSec) * 2_000),
  );
  const redisKey = `tb:${cfg.prefix}:${key}`;
  try {
    const redis = getRedis();
    // ioredis exposes Redis' EVAL command via the `eval` method.
    // This runs the Lua script atomically on the server.
    const runScript = (redis as unknown as {
      eval: (...args: unknown[]) => Promise<unknown>;
    }).eval.bind(redis);
    const res = (await runScript(
      LUA_CONSUME,
      1,
      redisKey,
      cfg.capacity.toString(),
      cfg.refillPerSec.toString(),
      cost.toString(),
      Date.now().toString(),
      ttlMs.toString(),
    )) as [number, number, string];
    return {
      allowed: res[0] === 1,
      retryAfterMs: Number(res[1]),
      remaining: Number(res[2]),
    };
  } catch (err) {
    console.error("[tokenBucket] redis error, failing open:", err);
    return { allowed: true, retryAfterMs: 0, remaining: cfg.capacity };
  }
}
