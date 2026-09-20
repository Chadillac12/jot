/* eslint-disable obsidianmd/prefer-active-doc */
import { describe, expect, it } from 'vitest';
import {
	applyBackingStoreSize,
	DEFAULT_BACKING_STORE_LIMITS,
	readCanvasSurface,
	safeBackingStoreDpr,
} from '../src/canvas-surface';

function makeCanvas(): HTMLCanvasElement {
	return document.createElement('canvas');
}

describe('safeBackingStoreDpr', () => {
	it('preserves the requested DPR for ordinary PDF page sizes', () => {
		expect(safeBackingStoreDpr(1024, 1365, 3)).toBe(3);
	});

	it('reduces DPR when zoom would exceed the maximum canvas dimension', () => {
		const dpr = safeBackingStoreDpr(2400, 3200, 3);
		expect(dpr).toBeLessThan(3);
		const canvas = makeCanvas();
		applyBackingStoreSize(canvas, 2400, 3200, dpr);
		expect(canvas.width).toBeLessThanOrEqual(DEFAULT_BACKING_STORE_LIMITS.maxDimension);
		expect(canvas.height).toBeLessThanOrEqual(DEFAULT_BACKING_STORE_LIMITS.maxDimension);
	});

	it('reduces DPR when zoom would exceed the maximum canvas area', () => {
		const dpr = safeBackingStoreDpr(3500, 3500, 2);
		const canvas = makeCanvas();
		applyBackingStoreSize(canvas, 3500, 3500, dpr);
		expect(canvas.width * canvas.height).toBeLessThanOrEqual(
			DEFAULT_BACKING_STORE_LIMITS.maxArea,
		);
	});

	it('can fall below DPR 1 for an extremely large zoomed page instead of creating an unsafe canvas', () => {
		expect(safeBackingStoreDpr(10_000, 12_000, 2)).toBeLessThan(1);
	});

	it('keeps normalized drawing coordinates coherent after DPR is capped', () => {
		const canvas = makeCanvas();
		const cssWidth = 2400;
		const cssHeight = 3200;
		const dpr = safeBackingStoreDpr(cssWidth, cssHeight, 3);
		applyBackingStoreSize(canvas, cssWidth, cssHeight, dpr);
		canvas.style.width = `${cssWidth}px`;
		canvas.style.height = `${cssHeight}px`;
		const surface = readCanvasSurface(canvas);
		expect(surface.width).toBe(cssWidth);
		expect(surface.height).toBe(cssHeight);
		expect(surface.dpr).toBeCloseTo(dpr, 3);
	});
});
