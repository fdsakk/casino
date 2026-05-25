import "./lib/env"; // Validate env vars before anything else
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { logger } from "hono/logger";
import { serveStatic } from "hono/bun";
import { auth, useAuthMiddleware, type AuthUser } from "./auth";
import { expensesRouter } from "./games/expenses/router";
import { rouletteRouter } from "./games/roulette/router";
import { blackjackRouter } from "./games/blackjack/router";
import { plinkoRouter } from "./games/plinko/router";
import { statsRouter } from "./games/stats/router";
import {
  securityHeaders,
  apiCors,
  apiLimiter,
  authLimiter,
  spinLimiter,
  blackjackLimiter,
  plinkoIpLimiter,
} from "./middleware";
import { AppError, ErrorCode } from "./lib/errors";
import { handleMessage, type ServerMessage } from "./games/blackjack/wsHandler";
import { db } from "./db/postgres";
import { getRedis } from "./lib/redis";

interface Vars {
  Variables: {
    user: typeof auth.$Infer.Session.user | null;
    session: typeof auth.$Infer.Session | null;
  };
}

const app = new Hono<Vars>();

/* ============================================================================
   Global Error Handler
   ============================================================================ */

app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json(err.toJSON(), err.statusCode as import("hono/utils/http-status").ContentfulStatusCode);
  }
  console.error("[unhandled]", err);
  return c.json({ error: ErrorCode.INTERNAL_ERROR }, 500);
});

/* ============================================================================
   Global Middleware
   ============================================================================ */

app.use("*", securityHeaders);
app.use("*", logger());

/* ============================================================================
   Health Check
   ============================================================================ */

app.get("/health", async (c) => {
  try {
    await db.execute(sql`SELECT 1`);
    await getRedis().ping();
    return c.json({ status: "ok" });
  } catch (e) {
    return c.json({ status: "degraded", error: (e as Error).message }, 503);
  }
});

/* ============================================================================
   Rate Limiting
   ============================================================================ */

// Baseline limiter — applies to all /api/* routes except plinko, which has
// its own higher ceiling to allow ball-spam UX. Plinko also enforces a
// per-user Redis token bucket inside its service for fairness across IPs.
app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/plinko/")) return next();
  return apiLimiter(c, next);
});
app.use("/api/plinko/*", plinkoIpLimiter);
app.use("/api/auth/*", authLimiter);
app.use("/api/casino/spin", spinLimiter);
app.use("/api/blackjack/*", blackjackLimiter);

/* ============================================================================
   CORS & Auth
   ============================================================================ */

app.use("/api/*", apiCors);

app.use("/api/expenses/*", useAuthMiddleware);
app.use("/api/casino/*", useAuthMiddleware);
app.use("/api/blackjack/*", useAuthMiddleware);
app.use("/api/plinko/*", useAuthMiddleware);
app.use("/api/stats/*", useAuthMiddleware);
app.use("/api/me", useAuthMiddleware);

// Get current user info with role
app.get("/api/me", (c) => {
  const user = c.get("user") as AuthUser;
  return c.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  });
});

const apiRoutes = app
  .basePath("/api")
  .route("/expenses", expensesRouter)
  .route("/casino", rouletteRouter)
  .route("/blackjack", blackjackRouter)
  .route("/plinko", plinkoRouter)
  .route("/stats", statsRouter);

app.on(["POST", "GET"], "/api/auth/*", (c) => {
  return auth.handler(c.req.raw);
});

app.get(
  "*",
  serveStatic({
    root: "./client/dist",
    onNotFound(_, c) {
      c.text("Not Found", 404);
    },
  }),
);

app.get("*", serveStatic({ path: "./client/dist/index.html" }));

const port = Number(process.env.PORT) || 2137;

/* ============================================================================
   WebSocket upgrade — /api/blackjack/ws
   Bun handles WS on the same port as HTTP. The fetch handler upgrades the
   connection; game messages are dispatched in the websocket handler below.
   ============================================================================ */

const WS_PATH = "/api/blackjack/ws";

type WsData = { userId: string };

// Per-user message queue: each incoming WS message chains onto the previous
// Promise for that user, ensuring serial execution and preventing race conditions.
const wsQueues = new Map<string, Promise<void>>();

function enqueueWsMessage(
  userId: string,
  handler: () => Promise<void>,
): void {
  const prev = wsQueues.get(userId) ?? Promise.resolve();
  const next = prev.then(handler).catch(() => {
    // Errors are handled inside handler; swallow here to keep the chain alive.
  });
  wsQueues.set(userId, next);
}

const server = Bun.serve<WsData>({
  port,

  async fetch(req, srv) {
    // Upgrade WebSocket connections before Hono touches them
    if (new URL(req.url).pathname === WS_PATH) {
      const session = await auth.api.getSession({ headers: req.headers });
      if (!session) {
        return new Response("Unauthorized", { status: 401 });
      }
      const upgraded = srv.upgrade(req, {
        data: { userId: session.user.id },
      });
      if (upgraded) return undefined as unknown as Response;
      return new Response("WS upgrade failed", { status: 500 });
    }
    return app.fetch(req, { server: srv });
  },

  websocket: {
    message(ws, message) {
      const raw = typeof message === "string" ? message : message.toString();
      const send = (msg: ServerMessage) => ws.send(JSON.stringify(msg));
      enqueueWsMessage(ws.data.userId, async () => {
        try {
          await handleMessage(ws.data.userId, raw, send);
        } catch (err) {
          console.error("[ws] unhandled error:", err);
          ws.send(JSON.stringify({ type: "error", payload: { code: "internal_error" } }));
        }
      });
    },
    open(ws) {
      console.info(`[ws] connected userId=${ws.data.userId}`);
    },
    close(ws) {
      console.info(`[ws] disconnected userId=${ws.data.userId}`);
      // Clean up queue entry when connection closes to avoid memory leak.
      wsQueues.delete(ws.data.userId);
    },
  },
});

console.info(`[server] listening on port ${server.port}`);

/* ============================================================================
   Graceful Shutdown
   ============================================================================ */

let shuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`[server] ${signal} received, shutting down...`);
  server.stop();
  await getRedis().quit();
  console.info("[server] shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

export type ApiRoutes = typeof apiRoutes;
