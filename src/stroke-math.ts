import type { Tool } from './palette';

export interface NormalizedPoint {
	x: number;
	y: number;
	pressure: number;
}

export interface StrokeRenderProfile {
	version: 2;
	smoothing: number;
	pressureSensitivity: number;
}

export const DEFAULT_STROKE_RENDER_PROFILE: StrokeRenderProfile = {
	version: 2,
	smoothing: 0.5,
	pressureSensitivity: 0.5,
};

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

export function strokeIntersects(stroke: Stroke, x: number, y: number, radius: number): boolean {
	const radiusSquared = radius * radius;
	if (stroke.points.some((point) => distanceSquared(point.x, point.y, x, y) < radiusSquared)) {
		return true;
	}
	for (let i = 1; i < stroke.points.length; i++) {
		const a = stroke.points[i - 1]!;
		const b = stroke.points[i]!;
		if (distanceToSegmentSquared(x, y, a.x, a.y, b.x, b.y) < radiusSquared) return true;
	}
	return false;
}

function distanceSquared(ax: number, ay: number, bx: number, by: number): number {
	const dx = ax - bx;
	const dy = ay - by;
	return dx * dx + dy * dy;
}

function distanceToSegmentSquared(
	px: number,
	py: number,
	ax: number,
	ay: number,
	bx: number,
	by: number,
): number {
	const vx = bx - ax;
	const vy = by - ay;
	const lengthSquared = vx * vx + vy * vy;
	if (lengthSquared === 0) return distanceSquared(px, py, ax, ay);
	const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / lengthSquared));
	return distanceSquared(px, py, ax + t * vx, ay + t * vy);
}
