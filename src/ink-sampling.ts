import type { NormalizedPoint } from './stroke-math';

export interface PointerSample {
	clientX: number;
	clientY: number;
	pressure: number;
}

export interface CoalescedPointerSource extends PointerSample {
	getCoalescedEvents?: () => PointerSample[];
}

export interface ClientRectLike {
	left: number;
	top: number;
	width: number;
	height: number;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * Return the highest-fidelity samples exposed by the browser for one pointer
 * event. Browsers may coalesce high-rate stylus samples into a single
 * pointermove; using the recovered samples keeps fast handwriting from becoming
 * a sparse polygonal path. The original event is a safe fallback everywhere.
 */
export function pointerSamples(event: CoalescedPointerSource): PointerSample[] {
	const getCoalescedEvents = event.getCoalescedEvents;
	if (typeof getCoalescedEvents !== 'function') return [event];

	try {
		const samples = getCoalescedEvents.call(event);
		return samples.length > 0 ? samples : [event];
	} catch {
		return [event];
	}
}

export function normalizedPointFromSample(
	sample: PointerSample,
	rect: ClientRectLike,
): NormalizedPoint {
	return {
		x: rect.width > 0 ? (sample.clientX - rect.left) / rect.width : 0,
		y: rect.height > 0 ? (sample.clientY - rect.top) / rect.height : 0,
		pressure: clamp01(sample.pressure),
	};
}

/**
 * Light low-pass filtering for stylus pressure. Position samples remain
 * untouched so the ink stays attached to the Pencil tip; only width changes are
 * damped to avoid visible pressure chatter.
 */
export class PressureSmoother {
	private value: number | null = null;

	constructor(private readonly responsiveness = 0.65) {}

	next(rawPressure: number): number {
		const pressure = clamp01(rawPressure);
		if (this.value === null) {
			this.value = pressure;
			return pressure;
		}
		const alpha = clamp01(this.responsiveness);
		this.value += (pressure - this.value) * alpha;
		return this.value;
	}

	reset(): void {
		this.value = null;
	}
}
