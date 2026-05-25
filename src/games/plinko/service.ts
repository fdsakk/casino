/* ============================================================================
   Plinko Service — orchestrates game logic and persistence

   Concurrency model: a user may have many Plinko balls in flight at once.
   Each call is independent — no shared mutable in-memory state per user.
   Race-safety comes from:
     1. Rate limiter (Redis token bucket, atomic Lua) caps drop frequency.
     2. Idempotency key uniqueness (DB unique index) guards double-submit.
     3. Balance change is a single atomic SQL UPDATE with WHERE balance
        + (win - bet) >= 0 — Postgres row-locks per UPDATE, so concurrent
        plays for the same user serialize without explicit transactions.
   ============================================================================ */

import { type Result, ok, err, ErrorCode } from "../../lib/errors";
import { db } from "../../db/postgres";
import { plinkoRound } from "../../db/schema";
import { balanceQueries } from "../../db/queries";
import { consumeToken } from "../../lib/tokenBucket";
import * as crypto from "crypto";
import { eq } from "drizzle-orm";
import { dropBall, type Difficulty } from "./engine";
import { hasActiveBlackjackGame } from "../blackjack/engine";
import type { PlinkoPlayResult } from "./types";

/* ============================================================================
   Per-user Rate Limit Config
   Capacity 20 lets users spam ~20 balls instantly. Refill 10/s sustains
   high-frequency drops without unbounded growth. Keyed by userId so a
   logged-in account cannot exceed its own budget regardless of IP.
   ============================================================================ */

const PLINKO_BUCKET = {
  capacity: 20,
  refillPerSec: 10,
  prefix: "plinko",
} as const;

/* ============================================================================
   Play Plinko
   ============================================================================ */

export async function play(
  userId: string,
  bet: number,
  rows: number,
  difficulty: Difficulty,
  idempotencyKey: string,
): Promise<Result<PlinkoPlayResult>> {
  // 1. Idempotency — return cached result if key already used.
  //    This also makes client retries safe.
  const existing = await db.query.plinkoRound.findFirst({
    where: eq(plinkoRound.idempotencyKey, idempotencyKey),
  });
  if (existing) {
    return ok({
      path: [],
      finalBucket: existing.finalBucket,
      multiplier: Number(existing.multiplier),
      win: Number(existing.totalWin),
      balance: Number(existing.balanceAfter),
    });
  }

  // 2. Per-user token-bucket rate limit. Allows bursts, caps sustained rate.
  const rl = await consumeToken(userId, PLINKO_BUCKET);
  if (!rl.allowed) {
    return err(
      ErrorCode.RATE_LIMITED,
      `Slow down — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`,
      { retryAfterMs: rl.retryAfterMs },
    );
  }

  // 3. Block play while a blackjack game is active.
  if (await hasActiveBlackjackGame(userId)) {
    return err(ErrorCode.ACTIVE_GAME_EXISTS, "Finish your blackjack game first");
  }

  // 4. Ensure balance row exists for new users.
  await balanceQueries.findOrCreateBalance(userId);

  // 5. Compute result before DB writes (pure — does not touch DB).
  const seed = crypto.randomBytes(16).toString("hex");
  const result = dropBall(bet, rows, difficulty, seed);
  const roundId = crypto.randomBytes(16).toString("hex");

  // 6. Atomic net balance change: -bet + win in a single UPDATE.
  //    Postgres row-locks the user_balance row for each UPDATE,
  //    so concurrent plays for the same user serialize correctly.
  const delta = result.win - bet;
  const applied = await balanceQueries.applyBalanceDelta(userId, delta);
  if (!applied) {
    return err(ErrorCode.INSUFFICIENT_FUNDS, "Insufficient funds");
  }

  // 7. Insert settled round. Idempotency uniqueness handles a rare double-
  //    submit (same key won the race) — surface as DUPLICATE to the client,
  //    which will then reissue with a new key.
  try {
    await db.insert(plinkoRound).values({
      id: roundId,
      userId,
      bet: bet.toString(),
      totalWin: result.win.toString(),
      rows,
      difficulty,
      finalBucket: result.finalBucket,
      multiplier: result.multiplier.toString(),
      balanceAfter: applied.newBalance.toString(),
      seed,
      idempotencyKey,
    });
  } catch (e) {
    // Roll the balance back if the insert race-collides on idempotencyKey.
    await balanceQueries.applyBalanceDelta(userId, -delta);
    return err(ErrorCode.DUPLICATE, "Duplicate request — retry with a new key");
  }

  return ok({
    path: result.path,
    finalBucket: result.finalBucket,
    multiplier: result.multiplier,
    win: result.win,
    balance: applied.newBalance,
  });
}
