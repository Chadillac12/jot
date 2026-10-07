import { describe, expect, it } from 'vitest';
import {
	MAX_INK_JSON_CHARACTERS,
	MAX_POINTS_PER_STROKE,
	parseJotText,
	parseStoredStroke,
} from '../src/jot-file';
import { parseJotNoteTextResult } from '../src/jot-note-file';

const point = { x: 0.25, y: 0.5, pressure: 0.8 };
const stroke = (points: typeof point[]) => ({
	tool: 'pen',
	color: '#123456',
	width: 0.005,
	points,
});

describe('ink resource limits', () => {
	it('rejects an oversized individual stroke before copying its points', () => {
		expect(parseStoredStroke(stroke(Array.from({ length: MAX_POINTS_PER_STROKE + 1 }, () => point)))).toBeNull();
	});

	it('keeps an oversized PDF sidecar unreadable rather than rendering it', () => {
		const oversized = ' '.repeat(MAX_INK_JSON_CHARACTERS + 1);
		expect(parseJotText(oversized)).toBeNull();
	});

	it('opens oversized notebooks read-only without parsing their ink', () => {
		const oversized = ' '.repeat(MAX_INK_JSON_CHARACTERS + 1);
		const result = parseJotNoteTextResult(oversized);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain('read-only');
	});

	it('keeps valid normal-sized strokes loadable', () => {
		expect(parseStoredStroke(stroke([point]))?.points).toHaveLength(1);
	});
});
