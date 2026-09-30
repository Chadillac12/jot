import { getStroke } from 'perfect-freehand';
import { widthFactorForPressure } from './stroke-math';
import type { NormalizedPoint, Stroke } from './stroke-math';

export interface CanvasSize {
	width: number;
	height: number;
	dpr?: number;
}

export const HIGHLIGHTER_ALPHA = 0.35;
export const HIGHLIGHTER_WIDTH_FACTOR = 4;

/**
 * These defaults intentionally favor low latency over heavy stabilization.
 * Coalesced Pencil samples provide most of the smoothness; perfect-freehand
 * then rounds the geometry without making the stroke feel detached from the
 * stylus tip.
 */
export const DEFAULT_INK_SMOOTHING = 0.5;
export const DEFAULT_PRESSURE_SENSITIVITY = 0.5;
export const PEN_SIZE_FACTOR = 1.15;

let inkSmoothing = DEFAULT_INK_SMOOTHING;
let pressureSensitivity = DEFAULT_PRESSURE_SENSITIVITY;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export function setInkRenderTuning(options: {
	smoothing: number;
	pressureSensitivity: number;
}): void {
	inkSmoothing = clamp01(options.smoothing);
	pressureSensitivity = clamp01(options.pressureSensitivity);
}

function penSmoothing(): number {
	return 0.45 + inkSmoothing * 0.4;
}

function penStreamline(): number {
	return 0.1 + inkSmoothing * 0.4;
}

function penThinning(): number {
	return 0.15 + pressureSensitivity * 0.8;
}

function denormalize(point: NormalizedPoint, canvas: CanvasSize) {
	return { x: point.x * canvas.width, y: point.y * canvas.height };
}

function applyDprTransform(ctx: CanvasRenderingContext2D, canvas: CanvasSize) {
	const dpr = canvas.dpr ?? 1;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function pressureScaledWidth(
	a: NormalizedPoint,
	b: NormalizedPoint,
	baseWidth: number,
	canvas: CanvasSize,
): number {
	const averagePressure = (a.pressure + b.pressure) / 2;
	return baseWidth * widthFactorForPressure(averagePressure) * canvas.height;
}

/**
 * Retained as a small primitive for tests and non-freehand geometry. Normal pen
 * strokes use drawPenStroke so the live and persisted paths share one renderer.
 */
export function drawSegment(
	ctx: CanvasRenderingContext2D,
	a: NormalizedPoint,
	b: NormalizedPoint,
	color: string,
	baseWidth: number,
	canvas: CanvasSize,
) {
	applyDprTransform(ctx, canvas);
	ctx.lineWidth = pressureScaledWidth(a, b, baseWidth, canvas);
	ctx.strokeStyle = color;
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';
	const start = denormalize(a, canvas);
	const end = denormalize(b, canvas);
	ctx.beginPath();
	ctx.moveTo(start.x, start.y);
	ctx.lineTo(end.x, end.y);
	ctx.stroke();
}

export function penOutline(
	points: NormalizedPoint[],
	baseWidth: number,
	canvas: CanvasSize,
): number[][] {
	if (points.length === 0) return [];
	const input: number[][] = points.map((point) => [
		point.x * canvas.width,
		point.y * canvas.height,
		point.pressure,
	]);
	return getStroke(input, {
		size: baseWidth * canvas.height * PEN_SIZE_FACTOR,
		thinning: penThinning(),
		smoothing: penSmoothing(),
		streamline: penStreamline(),
		simulatePressure: false,
		last: true,
	});
}

export function drawPenStroke(
	ctx: CanvasRenderingContext2D,
	points: NormalizedPoint[],
	color: string,
	baseWidth: number,
	canvas: CanvasSize,
) {
	const outline = penOutline(points, baseWidth, canvas);
	if (outline.length === 0) return;

	ctx.save();
	applyDprTransform(ctx, canvas);
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.moveTo(outline[0]![0]!, outline[0]![1]!);
	for (let i = 1; i < outline.length; i++) {
		const previous = outline[i - 1]!;
		const current = outline[i]!;
		ctx.quadraticCurveTo(
			previous[0]!,
			previous[1]!,
			(previous[0]! + current[0]!) / 2,
			(previous[1]! + current[1]!) / 2,
		);
	}
	ctx.closePath();
	ctx.fill();
	ctx.restore();
}

export function drawHighlighterPolyline(
	ctx: CanvasRenderingContext2D,
	points: NormalizedPoint[],
	color: string,
	baseWidth: number,
	canvas: CanvasSize,
) {
	if (points.length < 2) return;
	ctx.save();
	applyDprTransform(ctx, canvas);
	ctx.lineWidth = baseWidth * HIGHLIGHTER_WIDTH_FACTOR * canvas.height;
	ctx.strokeStyle = color;
	ctx.lineCap = 'butt';
	ctx.lineJoin = 'round';
	ctx.globalAlpha = HIGHLIGHTER_ALPHA;
	ctx.beginPath();
	const head = denormalize(points[0]!, canvas);
	ctx.moveTo(head.x, head.y);
	for (let i = 1; i < points.length; i++) {
		const next = denormalize(points[i]!, canvas);
		ctx.lineTo(next.x, next.y);
	}
	ctx.stroke();
	ctx.restore();
}

export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, canvas: CanvasSize) {
	if (stroke.tool === 'highlighter') {
		drawHighlighterPolyline(ctx, stroke.points, stroke.color, stroke.width, canvas);
		return;
	}
	drawPenStroke(ctx, stroke.points, stroke.color, stroke.width, canvas);
}
