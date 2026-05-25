import { type RefObject, useCallback, useEffect, useRef } from "react";
import { type Difficulty, getBucketColor, getMultipliers } from "./multipliers";

interface Waypoint {
	x: number;
	y: number;
}

interface CanvasGeometry {
	W: number;
	H: number;
	boardH: number;
	bucketBarH: number;
	pegSpacingX: number;
	pegSpacingY: number;
}

interface ActiveBall {
	id: string;
	waypoints: Waypoint[];
	startTime: number | null;
	totalDuration: number;
	finalBucket: number;
	pegSpacingY: number;
	done: boolean;
}

export interface BallEnqueueInput {
	id: string;
	path: number[];
	finalBucket: number;
}

export interface PlinkoCanvasController {
	enqueue: (ball: BallEnqueueInput) => void;
	cancel: (id: string) => void;
}

function getCanvasGeometry(
	canvas: HTMLCanvasElement,
	rows: number,
): CanvasGeometry {
	const W = canvas.width;
	const H = canvas.height;
	const bucketBarH = 36;
	const boardH = H - bucketBarH - 8;
	const pegSpacingY = boardH / (rows + 1);
	const pegSpacingX = W / (rows + 3);
	return { W, H, boardH, bucketBarH, pegSpacingX, pegSpacingY };
}

function roundRect(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	r: number,
) {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.lineTo(x + w - r, y);
	ctx.quadraticCurveTo(x + w, y, x + w, y + r);
	ctx.lineTo(x + w, y + h - r);
	ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
	ctx.lineTo(x + r, y + h);
	ctx.quadraticCurveTo(x, y + h, x, y + h - r);
	ctx.lineTo(x, y + r);
	ctx.quadraticCurveTo(x, y, x + r, y);
	ctx.closePath();
}

function formatMultiplierLabel(m: number): string {
	if (m >= 10000) return "10K";
	if (m >= 1000) return "1K";
	if (m >= 100) return `${Math.round(m)}`;
	return `${m}`;
}

function buildWaypoints(
	path: number[],
	W: number,
	H: number,
	bucketBarH: number,
	pegSpacingX: number,
	pegSpacingY: number,
): Waypoint[] {
	const waypoints: Waypoint[] = [{ x: W / 2, y: pegSpacingY * 0.3 }];
	let rights = 0;
	for (let r = 0; r < path.length; r++) {
		if (path[r] === 1) rights++;
		const pegsInRow = r + 3;
		const rowWidth = (pegsInRow - 1) * pegSpacingX;
		const startX = (W - rowWidth) / 2;
		waypoints.push({
			x: startX + (rights + 0.5) * pegSpacingX,
			y: pegSpacingY * (r + 1.3),
		});
	}
	const lastRowStartX = (W - (path.length + 1) * pegSpacingX) / 2;
	waypoints.push({
		x: lastRowStartX + (rights + 0.5) * pegSpacingX,
		y: H - bucketBarH - 6,
	});
	return waypoints;
}

interface UsePlinkoCanvasOptions {
	canvasRef: RefObject<HTMLCanvasElement | null>;
	rows: number;
	difficulty: Difficulty;
	onAnimationComplete: (ballId: string) => void;
	controllerRef: RefObject<PlinkoCanvasController | null>;
}

/**
 * Imperative canvas controller. The hook owns the animation loop entirely
 * via refs — no React state, no re-renders per frame, no prop diff per ball.
 * Callers push balls in via `controllerRef.current.enqueue(...)`.
 */
export function usePlinkoCanvas({
	canvasRef,
	rows,
	difficulty,
	onAnimationComplete,
	controllerRef,
}: UsePlinkoCanvasOptions) {
	// Offscreen cache for static board (pegs + bucket strip)
	const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
	const offscreenKeyRef = useRef<string>("");

	// Live state — all refs, no React state involved per frame
	const activeBallsRef = useRef<Map<string, ActiveBall>>(new Map());
	const recentBucketsRef = useRef<{ idx: number; flashUntil: number }[]>([]);
	const rafIdRef = useRef<number | null>(null);

	// Latest callback ref (so loop sees fresh closure without re-binding)
	const onCompleteRef = useRef(onAnimationComplete);
	useEffect(() => {
		onCompleteRef.current = onAnimationComplete;
	}, [onAnimationComplete]);

	// Geometry-dependent values change with rows/difficulty
	const rowsRef = useRef(rows);
	const difficultyRef = useRef(difficulty);
	// drawFrame is defined below; hold a forward ref to break the cycle so the
	// rows/difficulty effect can repaint without depending on the callback.
	const drawFrameRef = useRef<((now: number) => void) | null>(null);
	useEffect(() => {
		rowsRef.current = rows;
		difficultyRef.current = difficulty;
		offscreenKeyRef.current = "";
		if (rafIdRef.current === null && drawFrameRef.current) {
			rafIdRef.current = requestAnimationFrame(drawFrameRef.current);
		}
	}, [rows, difficulty]);

	const ensureOffscreen = useCallback((W: number, H: number) => {
		const rowsNow = rowsRef.current;
		const diffNow = difficultyRef.current;
		const cacheKey = `${rowsNow}|${diffNow}|${W}x${H}`;
		if (offscreenKeyRef.current === cacheKey && offscreenCanvasRef.current) {
			return offscreenCanvasRef.current;
		}
		const multipliers = getMultipliers(rowsNow, diffNow);
		const bucketBarH = 36;
		const boardH = H - bucketBarH - 8;
		const pegSpacingY = boardH / (rowsNow + 1);
		const pegSpacingX = W / (rowsNow + 3);
		const pegR = Math.max(3, Math.min(6, pegSpacingX * 0.12));

		const oc = document.createElement("canvas");
		oc.width = W;
		oc.height = H;
		const octx = oc.getContext("2d")!;

		for (let row = 0; row < rowsNow; row++) {
			const pegsInRow = row + 3;
			const rowWidth = (pegsInRow - 1) * pegSpacingX;
			const startX = (W - rowWidth) / 2;
			const y = pegSpacingY * (row + 1);
			for (let col = 0; col < pegsInRow; col++) {
				const x = startX + col * pegSpacingX;
				octx.beginPath();
				octx.arc(x, y, pegR, 0, Math.PI * 2);
				octx.fillStyle = "rgba(255,255,255,0.82)";
				octx.fill();
			}
		}

		const lastRowStartX = (W - (rowsNow + 1) * pegSpacingX) / 2;
		const byPos = H - bucketBarH;
		for (let i = 0; i < rowsNow + 1; i++) {
			const m = multipliers[i] ?? 0;
			const color = getBucketColor(m);
			const bucketCenterX = lastRowStartX + (i + 0.5) * pegSpacingX;
			const bx = bucketCenterX - pegSpacingX / 2;
			const pad = 2;
			octx.fillStyle = color;
			octx.strokeStyle = "rgba(0,0,0,0.35)";
			octx.lineWidth = 1;
			roundRect(
				octx,
				bx + pad,
				byPos + pad,
				pegSpacingX - pad * 2,
				bucketBarH - pad * 2,
				5,
			);
			octx.fill();
			octx.stroke();
			octx.fillStyle = "rgba(0,0,0,0.85)";
			octx.font = `bold ${Math.max(8, Math.min(11, pegSpacingX * 0.28))}px 'JetBrains Mono', monospace`;
			octx.textAlign = "center";
			octx.textBaseline = "middle";
			octx.fillText(
				formatMultiplierLabel(m),
				bucketCenterX,
				byPos + bucketBarH / 2,
			);
		}

		offscreenCanvasRef.current = oc;
		offscreenKeyRef.current = cacheKey;
		return oc;
	}, []);

	const drawFrame = useCallback(
		(now: number) => {
			const canvas = canvasRef.current;
			if (!canvas) {
				rafIdRef.current = null;
				return;
			}
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				rafIdRef.current = null;
				return;
			}

			const rowsNow = rowsRef.current;
			const difficultyNow = difficultyRef.current;
			const { W, H, bucketBarH, pegSpacingX } = getCanvasGeometry(
				canvas,
				rowsNow,
			);
			const pegR = Math.max(3, Math.min(6, pegSpacingX * 0.12));
			const multipliers = getMultipliers(rowsNow, difficultyNow);
			const offscreen = ensureOffscreen(W, H);

			ctx.clearRect(0, 0, W, H);
			ctx.drawImage(offscreen, 0, 0);

			// Bucket flash highlights
			const lastRowStartX = (W - (rowsNow + 1) * pegSpacingX) / 2;
			const byPos = H - bucketBarH;
			let writeIdx = 0;
			const flashes = recentBucketsRef.current;
			for (let i = 0; i < flashes.length; i++) {
				if (flashes[i].flashUntil <= now) continue;
				if (writeIdx !== i) flashes[writeIdx] = flashes[i];
				writeIdx++;
				const flash = flashes[i];
				const m = multipliers[flash.idx] ?? 0;
				const color = getBucketColor(m);
				const bucketCenterX = lastRowStartX + (flash.idx + 0.5) * pegSpacingX;
				const bx = bucketCenterX - pegSpacingX / 2;
				const pad = 2;
				const alpha = Math.max(0, Math.min(1, (flash.flashUntil - now) / 350));
				ctx.fillStyle = `rgba(255,255,255,${alpha})`;
				ctx.strokeStyle = "rgba(0,0,0,0.35)";
				ctx.lineWidth = 1;
				roundRect(
					ctx,
					bx + pad,
					byPos + pad,
					pegSpacingX - pad * 2,
					bucketBarH - pad * 2,
					5,
				);
				ctx.fill();
				ctx.stroke();
				ctx.fillStyle = color;
				ctx.font = `bold ${Math.max(8, Math.min(11, pegSpacingX * 0.28))}px 'JetBrains Mono', monospace`;
				ctx.textAlign = "center";
				ctx.textBaseline = "middle";
				ctx.fillText(
					formatMultiplierLabel(m),
					bucketCenterX,
					byPos + bucketBarH / 2,
				);
			}
			flashes.length = writeIdx;

			// Batch ball draws: share shadow setup once
			ctx.fillStyle = "#10b981";
			ctx.shadowColor = "#10b981";
			ctx.shadowBlur = 12;

			const completed: string[] = [];
			for (const ball of activeBallsRef.current.values()) {
				if (ball.startTime === null) ball.startTime = now;
				const globalT = Math.min(
					(now - ball.startTime) / ball.totalDuration,
					1,
				);
				const segCount = ball.waypoints.length - 1;
				const rawSeg = globalT * segCount;
				const segIdx = Math.min(Math.floor(rawSeg), segCount - 1);
				const localT = rawSeg - segIdx;
				// Cheaper ease — quadratic in/out without branching cost
				const easedT =
					localT < 0.5
						? 2 * localT * localT
						: 1 - 2 * (1 - localT) * (1 - localT);

				const p0 = ball.waypoints[segIdx];
				const p1 = ball.waypoints[segIdx + 1];
				const bx = p0.x + (p1.x - p0.x) * easedT;
				// Replace Math.sin with quadratic bump: 4t(1-t) peaks at 0.5
				const bump = 4 * localT * (1 - localT);
				const by =
					p0.y + (p1.y - p0.y) * easedT - ball.pegSpacingY * 0.25 * bump;

				ctx.beginPath();
				ctx.arc(bx, by, pegR * 1.3, 0, Math.PI * 2);
				ctx.fill();

				if (globalT >= 1 && !ball.done) {
					ball.done = true;
					completed.push(ball.id);
					flashes.push({ idx: ball.finalBucket, flashUntil: now + 700 });
				}
			}
			ctx.shadowBlur = 0;

			for (const id of completed) {
				activeBallsRef.current.delete(id);
				onCompleteRef.current(id);
			}

			if (
				activeBallsRef.current.size > 0 ||
				recentBucketsRef.current.length > 0
			) {
				rafIdRef.current = requestAnimationFrame(drawFrame);
			} else {
				rafIdRef.current = null;
			}
		},
		[canvasRef, ensureOffscreen],
	);

	// Publish drawFrame through the forward ref so the rows/difficulty effect
	// (declared above) can kick a single-frame repaint without depending on
	// the callback identity.
	useEffect(() => {
		drawFrameRef.current = drawFrame;
	}, [drawFrame]);

	// Build controller once, expose via ref
	useEffect(() => {
		const enqueue = (ball: BallEnqueueInput) => {
			const canvas = canvasRef.current;
			if (!canvas) return;
			const { W, H, bucketBarH, pegSpacingX, pegSpacingY } = getCanvasGeometry(
				canvas,
				rowsRef.current,
			);
			const waypoints = buildWaypoints(
				ball.path,
				W,
				H,
				bucketBarH,
				pegSpacingX,
				pegSpacingY,
			);
			activeBallsRef.current.set(ball.id, {
				id: ball.id,
				waypoints,
				startTime: null,
				totalDuration: Math.max(450, waypoints.length * 60),
				finalBucket: ball.finalBucket,
				pegSpacingY,
				done: false,
			});
			if (rafIdRef.current === null) {
				rafIdRef.current = requestAnimationFrame(drawFrame);
			}
		};
		const cancel = (id: string) => {
			activeBallsRef.current.delete(id);
		};
		controllerRef.current = { enqueue, cancel };
		return () => {
			controllerRef.current = null;
		};
	}, [canvasRef, controllerRef, drawFrame]);

	// Initial paint
	useEffect(() => {
		if (rafIdRef.current === null) {
			rafIdRef.current = requestAnimationFrame(drawFrame);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [drawFrame]);

	useEffect(() => {
		return () => {
			if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
			rafIdRef.current = null;
			activeBallsRef.current.clear();
			recentBucketsRef.current = [];
		};
	}, []);
}
