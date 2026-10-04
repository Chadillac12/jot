import { describe, expect, it, vi } from 'vitest';
import type { InkSurfaceController } from '../src/ink-surface';
import type { Stroke } from '../src/stroke-math';
import { StrokeStore } from '../src/stroke-store';
import { UndoController } from '../src/undo-controller';
import { UndoHistory } from '../src/undo';

const stroke = (color: string): Stroke => ({
	points: [{ x: 0.1, y: 0.1, pressure: 0.5 }],
	color,
	width: 0.005,
	tool: 'pen',
	render: { version: 2, smoothing: 0.5, pressureSensitivity: 0.5 },
});

describe('UndoController mutation guard', () => {
	it('does not expose or apply undo while the active document is locked', () => {
		const history = new UndoHistory();
		const strokes = new StrokeStore();
		strokes.setForKey('a.pdf::1', [stroke('#222222')]);
		history.push({
			pdfPath: 'a.pdf',
			key: 'a.pdf::1',
			prevStrokes: [stroke('#111111')],
		});
		const overlays = {
			overlayForKey: vi.fn(() => null),
			redrawPage: vi.fn(),
		} as unknown as InkSurfaceController;
		const afterApply = vi.fn();
		const controller = new UndoController(history, strokes, overlays, {
			activeDocumentPath: () => 'a.pdf',
			onAfterApply: afterApply,
			canMutate: () => false,
		});

		expect(controller.canUndo()).toBe(false);
		controller.undo();

		expect(strokes.forKey('a.pdf::1')[0]?.color).toBe('#222222');
		expect(afterApply).not.toHaveBeenCalled();
	});
});
