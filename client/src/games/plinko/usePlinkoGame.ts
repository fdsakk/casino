import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { generateIdempotencyKey } from "@/games/roulette/utils";
import { api, apiRequest } from "@/lib/api";
import type { PlinkoPlayResult } from "@/lib/plinko/api";
import { fetchBalance } from "@/lib/roulette/api";
import type { Difficulty } from "./multipliers";
import type { PlinkoCanvasController } from "./usePlinkoCanvas";

export interface PlinkoSettlement {
	id: string;
	bet: number;
	win: number;
	multiplier: number;
	bucket: number;
	delta: number;
	at: number;
}

const MAX_HISTORY = 30;
const SAFETY_TIMEOUT_MS = 12_000;

export interface UsePlinkoGameOptions {
	controllerRef: React.RefObject<PlinkoCanvasController | null>;
}

/**
 * Performance model:
 *  - Balls in flight do NOT live in React state. The canvas hook owns them
 *    in refs and runs a single rAF loop regardless of count.
 *  - Only `inFlightCount` triggers React renders, and we throttle it via
 *    rAF so spamming 50 balls doesn't cause 50 renders in a frame.
 *  - History updates also batched per frame.
 *  - Settlement → balance delta is applied via local optimistic state with
 *    no per-frame coupling.
 */
export function usePlinkoGame({ controllerRef }: UsePlinkoGameOptions) {
	const queryClient = useQueryClient();

	const { data: balanceData } = useQuery({
		queryKey: ["casino-balance"],
		queryFn: fetchBalance,
		staleTime: 5000,
	});
	const serverBalance = balanceData?.balance ?? 0;

	const [bet, setBet] = useState(100);
	const [rows, setRows] = useState(16);
	const [difficulty, setDifficulty] = useState<Difficulty>("expert");
	const [error, setError] = useState<string | null>(null);

	const [optimisticBalance, setOptimisticBalance] = useState(serverBalance);
	const [inFlightCount, setInFlightCount] = useState(0);
	const [history, setHistory] = useState<PlinkoSettlement[]>([]);
	const [sessionPnl, setSessionPnl] = useState(0);

	// Authoritative in-flight counter (ref) — drives "pending" tracking
	// independent of React render cycles. Coalesced into state via rAF.
	const inFlightRef = useRef(0);
	const inFlightRenderScheduledRef = useRef(false);
	const scheduleCountRender = useCallback(() => {
		if (inFlightRenderScheduledRef.current) return;
		inFlightRenderScheduledRef.current = true;
		requestAnimationFrame(() => {
			inFlightRenderScheduledRef.current = false;
			setInFlightCount(inFlightRef.current);
		});
	}, []);

	// Settlement queue — pending settlements drained in batches per frame
	const settlementQueueRef = useRef<PlinkoSettlement[]>([]);
	const drainScheduledRef = useRef(false);
	const drainSettlements = useCallback(() => {
		if (drainScheduledRef.current) return;
		drainScheduledRef.current = true;
		requestAnimationFrame(() => {
			drainScheduledRef.current = false;
			const batch = settlementQueueRef.current;
			if (batch.length === 0) return;
			settlementQueueRef.current = [];
			const deltaSum = batch.reduce((s, b) => s + b.delta, 0);
			setHistory((h) => [...batch.reverse(), ...h].slice(0, MAX_HISTORY));
			setSessionPnl((p) => p + deltaSum);
		});
	}, []);

	// Per-ball pending bet (for rollback on error) and safety timeouts
	const ballMetaRef = useRef<
		Map<
			string,
			{ bet: number; safetyTimer: ReturnType<typeof setTimeout> | null }
		>
	>(new Map());

	// Reconcile to server balance when no balls in flight (counter==0).
	useEffect(() => {
		if (inFlightRef.current === 0) {
			setOptimisticBalance(serverBalance);
		}
	}, [serverBalance]);

	useEffect(() => {
		const metas = ballMetaRef.current;
		return () => {
			for (const meta of metas.values()) {
				if (meta.safetyTimer) clearTimeout(meta.safetyTimer);
			}
			metas.clear();
		};
	}, []);

	const changeRows = (next: number) => {
		setRows(next);
		setError(null);
	};

	/**
	 * Called by the canvas hook when a ball's animation completes.
	 * Pushes settlement into the batched queue.
	 */
	const onAnimationComplete = useCallback(
		(ballId: string) => {
			const meta = ballMetaRef.current.get(ballId);
			if (!meta) return;
			if (meta.safetyTimer) clearTimeout(meta.safetyTimer);
			ballMetaRef.current.delete(ballId);

			inFlightRef.current = Math.max(0, inFlightRef.current - 1);
			scheduleCountRender();

			if (inFlightRef.current === 0) {
				queryClient.invalidateQueries({ queryKey: ["casino-balance"] });
			}
		},
		[queryClient, scheduleCountRender],
	);

	const play = useCallback(async () => {
		if (bet <= 0) return;
		if (bet > optimisticBalance) {
			setError("Insufficient funds");
			return;
		}

		const ballId = generateIdempotencyKey();
		setOptimisticBalance((b) => b - bet);
		inFlightRef.current += 1;
		scheduleCountRender();
		ballMetaRef.current.set(ballId, { bet, safetyTimer: null });

		try {
			const result = await apiRequest<PlinkoPlayResult>(
				api.plinko.play.$post({
					json: {
						bet,
						rows,
						difficulty,
						idempotencyKey: ballId,
					},
				}),
				"Something went wrong. Please try again.",
			);

			// Credit win optimistically (server-authoritative reconcile later).
			setOptimisticBalance((b) => b + result.win);

			// Push settlement into the batched history queue.
			settlementQueueRef.current.push({
				id: ballId,
				bet,
				win: result.win,
				multiplier: result.multiplier,
				bucket: result.finalBucket,
				delta: result.win - bet,
				at: Date.now(),
			});
			drainSettlements();

			// Hand off to canvas. The canvas calls onAnimationComplete on finish.
			controllerRef.current?.enqueue({
				id: ballId,
				path: result.path,
				finalBucket: result.finalBucket,
			});

			// Safety timer in case the rAF loop is paused (e.g. tab hidden)
			const meta = ballMetaRef.current.get(ballId);
			if (meta) {
				meta.safetyTimer = setTimeout(() => {
					controllerRef.current?.cancel(ballId);
					onAnimationComplete(ballId);
				}, SAFETY_TIMEOUT_MS);
			}
		} catch (e: unknown) {
			// Rollback: refund + drop ball
			setOptimisticBalance((b) => b + bet);
			const meta = ballMetaRef.current.get(ballId);
			if (meta?.safetyTimer) clearTimeout(meta.safetyTimer);
			ballMetaRef.current.delete(ballId);
			inFlightRef.current = Math.max(0, inFlightRef.current - 1);
			scheduleCountRender();
			const message =
				e instanceof Error
					? e.message
					: "Something went wrong. Please try again.";
			setError(message);
		}
	}, [
		bet,
		optimisticBalance,
		rows,
		difficulty,
		controllerRef,
		drainSettlements,
		onAnimationComplete,
		scheduleCountRender,
	]);

	const canPlay = bet > 0 && bet <= optimisticBalance && !error;

	return {
		bet,
		setBet,
		rows,
		changeRows,
		difficulty,
		setDifficulty,
		balance: optimisticBalance,
		inFlightCount,
		history,
		sessionPnl,
		canPlay,
		isPlaying: inFlightCount > 0,
		error,
		clearError: () => setError(null),
		play,
		onAnimationComplete,
	};
}
