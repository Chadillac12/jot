import { describe, expect, it } from 'vitest';
import {
	PressureSmoother,
	normalizedPointFromSample,
	pointerSamples,
} from '../src/ink-sampling';

describe('pointerSamples', () => {
	it('returns coalesced samples when the browser exposes them', () => {
		const samples = [
			{ clientX: 10, clientY: 20, pressure: 0.2 },
			{ clientX: 11, clientY: 21, pressure: 0.3 },
		];
		const event = {
			clientX: 12,
			clientY: 22,
			pressure: 0.4,
			getCoalescedEvents: () => samples,
		};
		expect(pointerSamples(event)).toBe(samples);
	});

	it('falls back to the original event when no coalesced samples exist', () => {
		const event = {
			clientX: 12,
			clientY: 22,
			pressure: 0.4,
			getCoalescedEvents: () => [],
		};
		expect(pointerSamples(event)).toEqual([event]);
	});

	it('falls back safely when the browser method throws', () => {
		const event = {
			clientX: 12,
			clientY: 22,
			pressure: 0.4,
			getCoalescedEvents: () => {
				throw new Error('unsupported');
			},
		};
		expect(pointerSamples(event)).toEqual([event]);
	});
});

describe('normalizedPointFromSample', () => {
	it('normalizes coordinates against the canvas client rect', () => {
		expect(
			normalizedPointFromSample(
				{ clientX: 250, clientY: 350, pressure: 0.75 },
				{ left: 50, top: 50, width: 400, height: 600 },
			),
		).toEqual({ x: 0.5, y: 0.5, pressure: 0.75 });
	});

	it('clamps pressure to the valid pointer range', () => {
		expect(
			normalizedPointFromSample(
				{ clientX: 0, clientY: 0, pressure: 2 },
				{ left: 0, top: 0, width: 100, height: 100 },
			).pressure,
		).toBe(1);
		expect(
			normalizedPointFromSample(
				{ clientX: 0, clientY: 0, pressure: -1 },
				{ left: 0, top: 0, width: 100, height: 100 },
			).pressure,
		).toBe(0);
	});
});

describe('PressureSmoother', () => {
	it('keeps the first pressure sample exact', () => {
		const smoother = new PressureSmoother(0.5);
		expect(smoother.next(0.8)).toBe(0.8);
	});

	it('damps abrupt pressure changes without adding position lag', () => {
		const smoother = new PressureSmoother(0.5);
		smoother.next(0);
		expect(smoother.next(1)).toBeCloseTo(0.5);
		expect(smoother.next(1)).toBeCloseTo(0.75);
	});

	it('resets between strokes', () => {
		const smoother = new PressureSmoother(0.5);
		smoother.next(0);
		smoother.next(1);
		smoother.reset();
		expect(smoother.next(1)).toBe(1);
	});
});
