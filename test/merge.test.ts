import type { PDFPage } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

import { snapshotStrokesForPdf } from '../src/merge-service';
import { drawStrokesOnPdfPage } from '../src/pdf-render';
import type { Stroke } from '../src/stroke-math';
import { StrokeStore } from '../src/stroke-store';

describe('drawStrokesOnPdfPage', () => {
	it('exports a one-point pen stroke instead of dropping it', () => {
		const drawSvgPath = vi.fn();
		const page = {
			getWidth: () => 600,
			getHeight: () => 800,
			drawSvgPath,
			drawLine: vi.fn(),
		} as unknown as PDFPage;
		const stroke: Stroke = {
			points: [{ x: 0.5, y: 0.5, pressure: 0.7 }],
			color: '#000000',
			width: 0.005,
			tool: 'pen',
			render: { version: 2, smoothing: 0.5, pressureSensitivity: 0.5 },
		};

		drawStrokesOnPdfPage(page, [stroke]);

		expect(drawSvgPath).toHaveBeenCalledTimes(1);
		expect(drawSvgPath.mock.calls[0]?.[0]).toContain('M');
	});
});


describe('snapshotStrokesForPdf', () => {
	it('freezes merge input so later store mutation cannot change the protected source', () => {
		const store = new StrokeStore();
		const stroke: Stroke = {
			points: [
				{ x: 0.1, y: 0.2, pressure: 0.5 },
				{ x: 0.3, y: 0.4, pressure: 0.7 },
			],
			color: '#123456',
			width: 0.005,
			tool: 'pen',
			render: { version: 2, smoothing: 0.4, pressureSensitivity: 0.6 },
		};
		store.setForKey('a.pdf::1', [stroke]);

		const snapshot = snapshotStrokesForPdf(store, 'a.pdf');
		store.clearFor('a.pdf');
		stroke.points[0]!.x = 0.9;
		if (stroke.render) stroke.render.smoothing = 1;

		expect(snapshot['1']).toHaveLength(1);
		expect(snapshot['1']?.[0]?.points[0]?.x).toBe(0.1);
		expect(snapshot['1']?.[0]?.render?.smoothing).toBe(0.4);
	});
});
