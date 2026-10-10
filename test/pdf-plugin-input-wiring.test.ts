import { describe, expect, it, vi } from 'vitest';
import { createPdfInputWiring } from '../src/pdf-input-wiring';
import type { PdfPointerForwarder } from '../src/pdf-page-binding';

describe('production PDF Pencil recovery wiring', () => {
	it('passes the page fallback registration channel through to the live ink handler', () => {
		const canvas = {} as HTMLCanvasElement;
		const originalEvent = {} as PointerEvent;
		const forward = vi.fn();
		const dispose = vi.fn();
		let installed: PdfPointerForwarder | null = null;
		const register = vi.fn((handler: PdfPointerForwarder | null) => {
			installed = handler;
		});
		const handler = vi.fn((
			_canvas: HTMLCanvasElement,
			setForwarder?: (callback: PdfPointerForwarder | null) => void,
		) => {
			setForwarder?.(forward);
			return dispose;
		});
		const wire = createPdfInputWiring(handler);
		expect(wire(canvas, register)).toBe(dispose);
		expect(handler).toHaveBeenCalledWith(canvas, register);
		expect(installed).toBe(forward);
		forward(originalEvent);
		expect(forward).toHaveBeenCalledWith(originalEvent);
	});
});
