import { describe, expect, it, vi } from 'vitest';
import { UndoController } from '../src/undo-controller';
import { UndoHistory } from '../src/undo';
import { StrokeStore } from '../src/stroke-store';
import type { InkSurfaceController } from '../src/ink-surface';

describe('DER document write authorization', () => {
	it('does not consume history or change strokes when persisted annotations are unreadable', () => {
		const history = new UndoHistory();
		const strokes = new StrokeStore();
		const notify = vi.fn();
		let permitted = false;
		const controller = new UndoController(
			history, strokes,
			{ overlayForKey: () => null } as unknown as InkSurfaceController,
			{
				activeDocumentPath: () => 'locked.pdf',
				onAfterApply: notify,
				canMutateDocument: () => permitted,
			},
		);
		controller.push({ pdfPath: 'locked.pdf', key: 'locked.pdf::1', prevStrokes: [] });
		expect(history.canUndo('locked.pdf')).toBe(true);
		expect(controller.canUndo()).toBe(false);
		controller.undo();
		expect(history.canUndo('locked.pdf')).toBe(true);
		expect(notify).not.toHaveBeenCalled();

		permitted = true;
		expect(controller.canUndo()).toBe(true);
		controller.undo();
		expect(history.canUndo('locked.pdf')).toBe(false);
		expect(controller.canRedo()).toBe(true);
		permitted = false;
		controller.redo();
		expect(history.canRedo('locked.pdf')).toBe(true);
	});
});
