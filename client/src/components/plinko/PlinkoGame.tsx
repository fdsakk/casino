import type { Difficulty } from "@server/games/plinko/engine";
import { ChevronDown, TrendingDown, TrendingUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	type PlinkoCanvasController,
	usePlinkoCanvas,
} from "@/games/plinko/usePlinkoCanvas";
import {
	type PlinkoSettlement,
	usePlinkoGame,
} from "@/games/plinko/usePlinkoGame";
import { formatBalance, formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

const DIFFICULTY_OPTIONS: { value: Difficulty; label: string }[] = [
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
	{ value: "expert", label: "Expert" },
];

const ROWS_OPTIONS = [8, 9, 10, 11, 12, 13, 14, 15, 16];

/**
 * Floating delta ticker — short-lived "+250 zł" / "-100 zł" pop-ups stacked
 * on the right side of the board. Each fades out after ~1.4s.
 */
function FloatingDeltas({ settlements }: { settlements: PlinkoSettlement[] }) {
	const [visible, setVisible] = useState<PlinkoSettlement[]>([]);
	const seenIds = useRef<Set<string>>(new Set());

	useEffect(() => {
		const fresh = settlements.filter((s) => !seenIds.current.has(s.id));
		if (fresh.length === 0) return;
		for (const s of fresh) seenIds.current.add(s.id);

		setVisible((prev) => [...fresh, ...prev].slice(0, 8));

		const timers = fresh.map((s) =>
			setTimeout(() => {
				setVisible((prev) => prev.filter((v) => v.id !== s.id));
			}, 1400),
		);
		return () => {
			for (const t of timers) clearTimeout(t);
		};
	}, [settlements]);

	return (
		<div className="pointer-events-none absolute top-2 right-2 z-10 flex flex-col gap-1 items-end">
			{visible.map((s) => (
				<div
					key={s.id}
					className={cn(
						"font-mono text-sm font-bold px-2 py-0.5 rounded-md backdrop-blur-sm",
						"animate-number-pop",
						s.delta > 0
							? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
							: s.delta < 0
								? "bg-red-500/10 text-red-300 border border-red-500/25"
								: "bg-muted text-muted-foreground border border-border",
					)}
				>
					{s.delta > 0 ? "+" : ""}
					{formatCurrency(s.delta)}
				</div>
			))}
		</div>
	);
}

export function PlinkoGame() {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const controllerRef = useRef<PlinkoCanvasController | null>(null);
	const game = usePlinkoGame({ controllerRef });

	usePlinkoCanvas({
		canvasRef,
		rows: game.rows,
		difficulty: game.difficulty,
		onAnimationComplete: game.onAnimationComplete,
		controllerRef,
	});

	const inFlight = game.inFlightCount;
	const totalWagered = game.history.reduce((s, h) => s + h.bet, 0);
	const totalReturned = game.history.reduce((s, h) => s + h.win, 0);

	return (
		<div className="flex flex-col lg:flex-row gap-4 items-start w-full min-w-0">
			{/* Controls panel */}
			<div className="w-full lg:w-64 shrink-0 space-y-4">
				{/* Bet Amount */}
				<div className="rounded-xl border border-border bg-card p-4 space-y-3">
					<div className="flex items-center justify-between">
						<span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
							Bet Amount
						</span>
						<span className="text-xs font-mono text-muted-foreground">
							{formatBalance(game.balance)} PLN
						</span>
					</div>

					<input
						type="number"
						min={1}
						max={game.balance}
						value={game.bet}
						onChange={(e) => game.setBet(Math.max(1, Number(e.target.value)))}
						className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
					/>

					<div className="flex gap-2">
						<Button
							variant="outline"
							size="sm"
							className="flex-1 text-xs font-semibold"
							onClick={() => game.setBet(Math.max(1, Math.floor(game.bet / 2)))}
						>
							&frac12;
						</Button>
						<Button
							variant="outline"
							size="sm"
							className="flex-1 text-xs font-semibold"
							onClick={() => game.setBet(Math.min(game.balance, game.bet * 2))}
						>
							2&times;
						</Button>
					</div>
				</div>

				{/* Difficulty */}
				<div className="rounded-xl border border-border bg-card p-4 space-y-2">
					<span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground block">
						Difficulty
					</span>
					<div className="relative">
						<select
							value={game.difficulty}
							onChange={(e) => game.setDifficulty(e.target.value as Difficulty)}
							className="w-full appearance-none rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary pr-8"
						>
							{DIFFICULTY_OPTIONS.map((o) => (
								<option key={o.value} value={o.value}>
									{o.label}
								</option>
							))}
						</select>
						<ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
					</div>
				</div>

				{/* Rows */}
				<div className="rounded-xl border border-border bg-card p-4 space-y-2">
					<span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground block">
						Rows
					</span>
					<div className="relative">
						<select
							value={game.rows}
							onChange={(e) => game.changeRows(Number(e.target.value))}
							className="w-full appearance-none rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary pr-8"
						>
							{ROWS_OPTIONS.map((r) => (
								<option key={r} value={r}>
									{r}
								</option>
							))}
						</select>
						<ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
					</div>
				</div>

				{/* Bet button — always enabled while funds remain. Spamming is OK;
				    server rate-limits per-user, client tracks in-flight balls. */}
				<Button
					className="w-full h-11 text-sm font-bold bg-primary hover:bg-primary/90 text-primary-foreground"
					disabled={!game.canPlay}
					onClick={game.play}
				>
					{inFlight > 0 ? `Drop (${inFlight} in flight)` : "Drop"}
				</Button>

				{/* Error feedback */}
				{game.error && (
					<div className="rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-center">
						<div className="text-xs font-semibold text-red-400">
							{game.error}
						</div>
						<button
							type="button"
							className="mt-1 text-xs text-muted-foreground underline"
							onClick={game.clearError}
						>
							Dismiss
						</button>
					</div>
				)}

				{/* Session P/L */}
				<div
					className={cn(
						"rounded-xl border p-3",
						game.sessionPnl > 0
							? "border-emerald-500/30 bg-emerald-500/5"
							: game.sessionPnl < 0
								? "border-red-500/20 bg-red-500/5"
								: "border-border bg-card",
					)}
				>
					<div className="flex items-center justify-between mb-1">
						<span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
							Session P/L
						</span>
						{game.sessionPnl > 0 ? (
							<TrendingUp className="h-3.5 w-3.5 text-emerald-400" />
						) : game.sessionPnl < 0 ? (
							<TrendingDown className="h-3.5 w-3.5 text-red-400" />
						) : null}
					</div>
					<div
						className={cn(
							"text-xl font-bold font-mono tabular-nums",
							game.sessionPnl > 0
								? "text-emerald-400"
								: game.sessionPnl < 0
									? "text-red-400"
									: "text-foreground",
						)}
					>
						{game.sessionPnl > 0 ? "+" : ""}
						{formatCurrency(game.sessionPnl)}
					</div>
					<div className="mt-1 grid grid-cols-2 gap-1 text-[10px] font-mono text-muted-foreground">
						<div>
							Wagered
							<div className="text-foreground">
								{formatCurrency(totalWagered)}
							</div>
						</div>
						<div>
							Returned
							<div className="text-foreground">
								{formatCurrency(totalReturned)}
							</div>
						</div>
					</div>
				</div>
			</div>

			{/* Board + ancillary panels */}
			<div className="flex-1 min-w-0 w-full space-y-3">
				<div className="relative rounded-2xl border border-border bg-card p-2 sm:p-4 flex items-center justify-center min-h-[420px] overflow-hidden">
					<FloatingDeltas settlements={game.history} />
					<canvas
						ref={canvasRef}
						width={680}
						height={480}
						className="w-full max-w-[680px] h-auto"
						style={{ imageRendering: "crisp-edges" }}
					/>
				</div>

				{/* Recent results strip */}
				{game.history.length > 0 && (
					<div className="rounded-xl border border-border bg-card p-3 min-w-0">
						<div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
							Recent drops
						</div>
						<div className="flex gap-1.5 overflow-x-auto pb-1 min-w-0">
							{game.history.map((h) => (
								<div
									key={h.id}
									className={cn(
										"shrink-0 rounded-md px-2 py-1 text-[11px] font-mono font-semibold border",
										h.delta > 0
											? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
											: h.delta < 0
												? "border-red-500/25 bg-red-500/10 text-red-300"
												: "border-border bg-secondary text-foreground",
									)}
									title={`bet ${h.bet} · win ${h.win} · ${h.multiplier}×`}
								>
									{h.multiplier}×
								</div>
							))}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
