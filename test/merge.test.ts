import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { drawStrokesOnPdfPage } from '../src/merge';

describe('drawStrokesOnPdfPage', () => {
	it('exports a single-point pen stroke instead of dropping the mark', async () => {
		const pdf = await PDFDocument.create();
		const page = pdf.addPage([612, 792]);
		const drawSvgPath = vi.spyOn(page, 'drawSvgPath');

		drawStrokesOnPdfPage(page, [
			{
				points: [{ x: 0.5, y: 0.5, pressure: 0.6 }],
				color: '#123456',
				width: 0.0025,
				tool: 'pen',
				render: { version: 2, smoothing: 0.5, pressureSensitivity: 0.5 },
			},
		]);

		expect(drawSvgPath).toHaveBeenCalledTimes(1);
		expect(drawSvgPath.mock.calls[0]?.[0]).not.toBe('');
	});
});
