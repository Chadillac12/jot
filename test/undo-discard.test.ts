import { describe, expect, it } from 'vitest';
import { UndoHistory } from '../src/undo';

describe('UndoHistory.discardLatestMatching', () => {
	it('removes only the newest matching undo entry without creating redo history', () => {
		const history = new UndoHistory();
		history.push({ pdfPath: 'a.pdf', key: 'a.pdf::1', prevStrokes: [] });

		const discarded = history.discardLatestMatching('a.pdf', 'a.pdf::1');

		expect(discarded?.key).toBe('a.pdf::1');
		expect(history.canUndo('a.pdf')).toBe(false);
		expect(history.canRedo('a.pdf')).toBe(false);
	});

	it('refuses to remove an unrelated newest undo entry', () => {
		const history = new UndoHistory();
		history.push({ pdfPath: 'a.pdf', key: 'a.pdf::1', prevStrokes: [] });

		expect(history.discardLatestMatching('a.pdf', 'a.pdf::2')).toBeNull();
		expect(history.canUndo('a.pdf')).toBe(true);
	});
});
