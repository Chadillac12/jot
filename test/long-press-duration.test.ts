import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LongPressDetector } from '../src/long-press';

describe('LongPressDetector duration override', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('can use the configured Pencil duration for a single start', () => {
		const onFire = vi.fn();
		const detector = new LongPressDetector(
			{ durationMs: 300, movementThresholdPx: 15 },
			{ onFire },
		);
		detector.start(0, 0, 500);
		vi.advanceTimersByTime(300);
		expect(onFire).not.toHaveBeenCalled();
		vi.advanceTimersByTime(200);
		expect(onFire).toHaveBeenCalledTimes(1);
	});
});
