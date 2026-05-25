/* ============================================================================
   Middleware Configuration — rate limiters, CORS, security headers
   
   Extracted from index.ts for cleaner app composition.
   Each middleware is a standalone function that can be tested independently.
   ============================================================================ */

import { secureHeaders } from "hono/secure-headers";
import { cors } from "hono/cors";
import { rateLimiter } from "hono-rate-limiter";
import type { Context } from "hono";

/* ============================================================================
   Helpers
   ============================================================================ */

const DEFAULT_TRUSTED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://0.0.0.0:3000",
];

type TrustedProxyHeader = "cf-connecting-ip" | "x-forwarded-for" | "x-real-ip";

const trustedProxyHeader = (
  process.env.TRUSTED_PROXY_HEADER?.trim().toLowerCase() ?? ""
) as TrustedProxyHeader | "";

function parseTrustedOrigins(): string[] {
  const configured = (process.env.TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  const origins = configured.length > 0 ? configured : [...DEFAULT_TRUSTED_ORIGINS];
  const betterAuthUrl = process.env.BETTER_AUTH_URL?.trim();
  if (betterAuthUrl && !origins.includes(betterAuthUrl)) {
    origins.push(betterAuthUrl);
  }
  return origins;
}

const trustedOrigins = parseTrustedOrigins();

function firstIpFromXForwardedFor(value: string): string | undefined {
  const first = value.split(",")[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

function trustedHeaderIp(c: Context): string | undefined {
  if (trustedProxyHeader === "cf-connecting-ip") {
    return c.req.header("cf-connecting-ip")?.trim() || undefined;
  }
  if (trustedProxyHeader === "x-real-ip") {
    return c.req.header("x-real-ip")?.trim() || undefined;
  }
  if (trustedProxyHeader === "x-forwarded-for") {
    const header = c.req.header("x-forwarded-for");
    return header ? firstIpFromXForwardedFor(header) : undefined;
  }
  return undefined;
}

function socketRemoteIp(c: Context): string {
  if (typeof c.env === "object" && c.env !== null) {
    const maybeServer = "server" in c.env
      ? (c.env as { server?: { requestIP?: (request: Request) => { address: string } } }).server
      : (c.env as { requestIP?: (request: Request) => { address: string } });

    if (maybeServer && typeof maybeServer.requestIP === "function") {
      const info = maybeServer.requestIP(c.req.raw);
      if (info?.address) {
        return info.address;
      }
    }
  }

  return "127.0.0.1";
}

function clientIp(c: Context): string {
  return trustedHeaderIp(c) ?? socketRemoteIp(c);
}

/* ============================================================================
   Security Headers
   ============================================================================ */

export const securityHeaders = secureHeaders({
  xFrameOptions: "DENY",
  xContentTypeOptions: "nosniff",
  referrerPolicy: "strict-origin-when-cross-origin",
  crossOriginEmbedderPolicy: false,
});

/* ============================================================================
   CORS
   ============================================================================ */

export const apiCors = cors({
  origin: trustedOrigins,
  allowHeaders: ["Content-Type", "Authorization"],
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  exposeHeaders: ["Content-Length"],
  maxAge: 600,
  credentials: true,
});

/* ============================================================================
   Rate Limiters
   ============================================================================ */

/** General API rate limit: 100 requests/minute */
export const apiLimiter = rateLimiter({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: "draft-6",
  keyGenerator: clientIp,
});

/** Auth endpoints: 20 requests/minute */
export const authLimiter = rateLimiter({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-6",
  keyGenerator: clientIp,
});

/** Roulette spin: 30 spins/minute */
export const spinLimiter = rateLimiter({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-6",
  keyGenerator: clientIp,
});

/** Blackjack actions: 60 actions/minute */
export const blackjackLimiter = rateLimiter({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-6",
  keyGenerator: clientIp,
});

/**
 * Plinko IP-level safeguard: high ceiling for spam-friendly play, but
 * still caps a single IP to prevent DDoS amplification. Per-user budget
 * is enforced separately by the Redis token bucket in PlinkoService.
 */
export const plinkoIpLimiter = rateLimiter({
  windowMs: 60 * 1000,
  limit: 800,
  standardHeaders: "draft-6",
  keyGenerator: clientIp,
});
