import { getStroke } from 'perfect-freehand';
import {
	STROKE_RENDER_VERSION,
	widthFactorForPressure,
	type NormalizedPoint,
	type Stroke,
	type StrokeRenderProfile,
} from './stroke-math';

export interface CanvasSize {
	width: number;
	height: number;
	dpr?: number;
}

export const HIGHLIGHTER_ALPHA = 0.35;
export const HIGHLIGHTER_WIDTH_FACTOR = 4;
export const DEFAULT_INK_SMOOTHING = 0.5;
export const DEFAULT_PRESSURE_SENSITIVITY = 0.5;
export const PEN_SIZE_FACTOR = 1.15;

export const DEFAULT_STROKE_RENDER_PROFILE: StrokeRenderProfile = {
	version: STROKE_RENDER_VERSION,
	smoothing: DEFAULT_INK_SMOOTHING,
	pressureSensitivity: DEFAULT_PRESSURE_SENSITIVITY,
};

let currentRenderProfile: StrokeRenderProfile = { ...DEFAULT_STROKE_RENDER_PROFILE };

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export function setInkRenderTuning(options: {
	smoothing: number;
	pressureSensitivity: number;
}): void {
	currentRenderProfile = {
		version: STROKE_RENDER_VERSION,
		smoothing: clamp01(options.smoothing),
		pressureSensitivity: clamp01(options.pressureSensitivity),
	};
}

export function currentInkRenderProfile(): StrokeRenderProfile {
	return { ...currentRenderProfile };
}

function profileFor(stroke: Stroke): StrokeRenderProfile {
	return stroke.render ?? DEFAULT_STROKE_RENDER_PROFILE;
}

function penSmoothing(profile: StrokeRenderProfile): number {
	return 0.45 + clamp01(profile.smoothing) * 0.4;
}

function penStreamline(profile: StrokeRenderProfile): number {
	return 0.1 + clamp01(profile.smoothing) * 0.4;
}

function penThinning(profile: StrokeRenderProfile): number {
	return 0.15 + clamp01(profile.pressureSensitivity) * 0.8;
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
	profile: StrokeRenderProfile = DEFAULT_STROKE_RENDER_PROFILE,
): number[][] {
	if (points.length === 0) return [];
	const input: number[][] = points.map((point) => [
		point.x * canvas.width,
		point.y * canvas.height,
		point.pressure,
	]);
	return getStroke(input, {
		size: baseWidth * canvas.height * PEN_SIZE_FACTOR,
		thinning: penThinning(profile),
		smoothing: penSmoothing(profile),
		streamline: penStreamline(profile),
		simulatePressure: false,
		last: true,
	});
}

export function svgPathFromOutline(outline: number[][]): string {
	if (outline.length === 0) return '';
	const r2 = (value: number): string => (Math.round(value * 100) / 100).toString();
	let path = `M${r2(outline[0]![0]!)} ${r2(outline[0]![1]!)}`;
	for (let i = 1; i < outline.length; i++) {
		const previous = outline[i - 1]!;
		const current = outline[i]!;
		path +=
			` Q${r2(previous[0]!)} ${r2(previous[1]!)}` +
			` ${r2((previous[0]! + current[0]!) / 2)} ${r2((previous[1]! + current[1]!) / 2)}`;
	}
	return path + ' Z';
}

export function drawPenStroke(
	ctx: CanvasRenderingContext2D,
	points: NormalizedPoint[],
	color: string,
	baseWidth: number,
	canvas: CanvasSize,
	profile: StrokeRenderProfile = DEFAULT_STROKE_RENDER_PROFILE,
) {
	const outline = penOutline(points, baseWidth, canvas, profile);
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
	if (stroke.tool === 'eraser') return;
	if (stroke.tool === 'highlighter') {
		drawHighlighterPolyline(ctx, stroke.points, stroke.color, stroke.width, canvas);
		return;
	}
	drawPenStroke(ctx, stroke.points, stroke.color, stroke.width, canvas, profileFor(stroke));
}
