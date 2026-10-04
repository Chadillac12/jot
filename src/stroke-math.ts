import type { Tool } from './palette';

export interface NormalizedPoint {
	x: number;
	y: number;
	pressure: number;
}

export const STROKE_RENDER_VERSION = 2;

export interface StrokeRenderProfile {
	version: typeof STROKE_RENDER_VERSION;
	smoothing: number;
	pressureSensitivity: number;
}

export interface Stroke {
	points: NormalizedPoint[];
	color: string;
	width: number;
	tool: Tool;
	render?: StrokeRenderProfile;
}

export type SegmentEmit = (a: NormalizedPoint, b: NormalizedPoint) => void;

export const PRESSURE_MIN_FACTOR = 0.5;
export const PRESSURE_MAX_FACTOR = 1.8;
export const ERASE_RADIUS = 0.02;
export const SMOOTH_SUBDIVISIONS = 6;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export function widthFactorForPressure(pressure: number): number {
	const t = clamp01(pressure);
	return PRESSURE_MIN_FACTOR + (PRESSURE_MAX_FACTOR - PRESSURE_MIN_FACTOR) * t;
}

export function midpoint(a: NormalizedPoint, b: NormalizedPoint): NormalizedPoint {
	return {
		x: (a.x + b.x) / 2,
		y: (a.y + b.y) / 2,
		pressure: (a.pressure + b.pressure) / 2,
	};
}

export function subdivideQuadratic(
	start: NormalizedPoint,
	control: NormalizedPoint,
	end: NormalizedPoint,
	steps: number,
	emit: SegmentEmit,
) {
	let previous = start;
	for (let i = 1; i <= steps; i++) {
		const t = i / steps;
		const next = quadraticAt(start, control, end, t);
		emit(previous, next);
		previous = next;
	}
}

function quadraticAt(
	start: NormalizedPoint,
	control: NormalizedPoint,
	end: NormalizedPoint,
	t: number,
): NormalizedPoint {
	const inv = 1 - t;
	return {
		x: inv * inv * start.x + 2 * inv * t * control.x + t * t * end.x,
		y: inv * inv * start.y + 2 * inv * t * control.y + t * t * end.y,
		pressure: inv * start.pressure + t * end.pressure,
	};
}

export function forEachSmoothSegment(points: NormalizedPoint[], emit: SegmentEmit) {
	if (points.length < 2) return;
	const first = points[0]!;
	const second = points[1]!;
	if (points.length === 2) {
		emit(first, second);
		return;
	}
	let previousMidpoint = midpoint(first, second);
	emit(first, previousMidpoint);
	for (let i = 1; i < points.length - 1; i++) {
		const control = points[i]!;
		const nextMidpoint = midpoint(control, points[i + 1]!);
		subdivideQuadratic(previousMidpoint, control, nextMidpoint, SMOOTH_SUBDIVISIONS, emit);
		previousMidpoint = nextMidpoint;
	}
	emit(previousMidpoint, points[points.length - 1]!);
}

export function strokeIntersects(
	stroke: Stroke,
	x: number,
	y: number,
	radiusX: number,
	radiusY = radiusX,
): boolean {
	if (stroke.points.length === 0 || radiusX <= 0 || radiusY <= 0) return false;
	const sx = 1 / radiusX;
	const sy = 1 / radiusY;
	const targetX = x * sx;
	const targetY = y * sy;

	const scaled = stroke.points.map((point) => ({
		x: point.x * sx,
		y: point.y * sy,
	}));
	for (const point of scaled) {
		const dx = point.x - targetX;
		const dy = point.y - targetY;
		if (dx * dx + dy * dy <= 1) return true;
	}
	for (let i = 1; i < scaled.length; i++) {
		if (
			pointToSegmentDistanceSquared(
				targetX,
				targetY,
				scaled[i - 1]!,
				scaled[i]!,
			) <= 1
		) {
			return true;
		}
	}
	return false;
}

function pointToSegmentDistanceSquared(
	px: number,
	py: number,
	a: { x: number; y: number },
	b: { x: number; y: number },
): number {
	const vx = b.x - a.x;
	const vy = b.y - a.y;
	const lengthSquared = vx * vx + vy * vy;
	if (lengthSquared === 0) {
		const dx = px - a.x;
		const dy = py - a.y;
		return dx * dx + dy * dy;
	}
	const projection = ((px - a.x) * vx + (py - a.y) * vy) / lengthSquared;
	const t = Math.max(0, Math.min(1, projection));
	const dx = px - (a.x + t * vx);
	const dy = py - (a.y + t * vy);
	return dx * dx + dy * dy;
}
