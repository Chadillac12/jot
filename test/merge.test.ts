import type { PDFPage } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => ({ App: class {}, Modal: class {} }));
import { drawStrokesOnPdfPage } from '../src/merge';
import type { Stroke } from '../src/stroke-math';

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
