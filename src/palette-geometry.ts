import type { Handedness } from './palette';

export interface Offset {
	ox: number;
	oy: number;
}

export interface OffsetBounds {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

export interface SubArcSpec {
	slot: number;
	count: number;
}

export const MAIN_ARC_RADIUS = 110;
export const SUB_ARC_RADIUS = 166;
export const ANCHOR_OFFSET_PX = 60;
export const RADIAL_MARGIN_PX = 16;
export const MAIN_ITEM_COUNT = 6;
export const BG_ANGULAR_PAD_DEG = 4;
export const SVG_HALF = 280;

const TILT_OFFSET_DEG = 20;
const ITEM_ANGULAR_DEG = 24;

export const MAIN_ITEM_STEP_RAD = (ITEM_ANGULAR_DEG * Math.PI) / 180;
export const SUB_ITEM_STEP_RAD = 2 * Math.asin((MAIN_ARC_RADIUS / SUB_ARC_RADIUS) * Math.sin(MAIN_ITEM_STEP_RAD / 2));

const STRAIGHT_UP_RAD = (3 * Math.PI) / 2;
const STRAIGHT_DOWN_RAD = Math.PI / 2;
const TILT_RAD = (TILT_OFFSET_DEG * Math.PI) / 180;

export function arcCenterAngle(handedness: Handedness, flipDown: boolean): number {
	const base = flipDown ? STRAIGHT_DOWN_RAD : STRAIGHT_UP_RAD;
	const awayFromHand = handedness === 'right' ? -TILT_RAD : TILT_RAD;
	return flipDown ? base - awayFromHand : base + awayFromHand;
}

export function arcOrigin(handedness: Handedness, flipDown: boolean): Offset {
	const center = arcCenterAngle(handedness, flipDown);
	return {
		ox: -ANCHOR_OFFSET_PX * Math.cos(center),
		oy: -ANCHOR_OFFSET_PX * Math.sin(center),
	};
}

export function slotAngle(slot: number, handedness: Handedness, flipDown: boolean): number {
	const center = arcCenterAngle(handedness, flipDown);
	const offsetFromCenter = slot - (MAIN_ITEM_COUNT - 1) / 2;
	return center + offsetFromCenter * MAIN_ITEM_STEP_RAD;
}

export function mainSlotOffset(slot: number, handedness: Handedness, flipDown: boolean): Offset {
	const origin = arcOrigin(handedness, flipDown);
	const theta = slotAngle(slot, handedness, flipDown);
	return {
		ox: Math.round(origin.ox + MAIN_ARC_RADIUS * Math.cos(theta)),
		oy: Math.round(origin.oy + MAIN_ARC_RADIUS * Math.sin(theta)),
	};
}

export function subSlotOffset(
	index: number,
	count: number,
	centerTheta: number,
	handedness: Handedness,
	flipDown: boolean,
): Offset {
	const origin = arcOrigin(handedness, flipDown);
	const span = (count - 1) * SUB_ITEM_STEP_RAD;
	const theta =
		count === 1 ? centerTheta : centerTheta - span / 2 + index * SUB_ITEM_STEP_RAD;
	return {
		ox: Math.round(origin.ox + SUB_ARC_RADIUS * Math.cos(theta)),
		oy: Math.round(origin.oy + SUB_ARC_RADIUS * Math.sin(theta)),
	};
}

export function paletteOffsetBounds(
	handedness: Handedness,
	flipDown: boolean,
	subArcs: SubArcSpec[],
	paddingPx = 30,
): OffsetBounds {
	const offsets: Offset[] = [arcOrigin(handedness, flipDown)];
	for (let slot = 0; slot < MAIN_ITEM_COUNT; slot++) {
		offsets.push(mainSlotOffset(slot, handedness, flipDown));
	}
	for (const spec of subArcs) {
		if (spec.count <= 0) continue;
		const center = slotAngle(spec.slot, handedness, flipDown);
		for (let index = 0; index < spec.count; index++) {
			offsets.push(subSlotOffset(index, spec.count, center, handedness, flipDown));
		}
	}

	return {
		minX: Math.min(...offsets.map((p) => p.ox)) - paddingPx,
		maxX: Math.max(...offsets.map((p) => p.ox)) + paddingPx,
		minY: Math.min(...offsets.map((p) => p.oy)) - paddingPx,
		maxY: Math.max(...offsets.map((p) => p.oy)) + paddingPx,
	};
}

export function clampPaletteAnchor(
	clientX: number,
	clientY: number,
	viewportWidth: number,
	viewportHeight: number,
	bounds: OffsetBounds,
	marginPx = RADIAL_MARGIN_PX,
): { x: number; y: number } {
	return {
		x: clampAxis(clientX, viewportWidth, bounds.minX, bounds.maxX, marginPx),
		y: clampAxis(clientY, viewportHeight, bounds.minY, bounds.maxY, marginPx),
	};
}

export function arcCenterlinePath(radius: number, startAngle: number, endAngle: number): string {
	const start = pointOnArc(radius, startAngle);
	const end = pointOnArc(radius, endAngle);
	const largeArc = Math.abs(endAngle - startAngle) > Math.PI ? 1 : 0;
	return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

function clampAxis(
	value: number,
	viewportSize: number,
	minOffset: number,
	maxOffset: number,
	marginPx: number,
): number {
	const minAnchor = marginPx - minOffset;
	const maxAnchor = viewportSize - marginPx - maxOffset;
	if (minAnchor > maxAnchor) return viewportSize / 2;
	return Math.min(maxAnchor, Math.max(minAnchor, value));
}

function pointOnArc(radius: number, angle: number): { x: number; y: number } {
	return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
}
