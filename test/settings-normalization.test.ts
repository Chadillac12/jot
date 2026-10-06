import { describe, expect, it } from 'vitest';

import {
	DEFAULT_SETTINGS,
	normalizeJotSettings,
} from '../src/settings';

describe('normalizeJotSettings', () => {
	it('returns safe defaults for missing settings', () => {
		const normalized = normalizeJotSettings(null);
		expect(normalized).toEqual(DEFAULT_SETTINGS);
		expect(normalized).not.toBe(DEFAULT_SETTINGS);
		expect(normalized.toolState).not.toBe(DEFAULT_SETTINGS.toolState);
		expect(normalized.colors).not.toBe(DEFAULT_SETTINGS.colors);
	});

	it('repairs malformed tool state, memories, colors and scalar values', () => {
		const normalized = normalizeJotSettings({
			handedness: 'upside-down',
			toolState: { tool: 'laser', color: 'red', width: -1 },
			penState: { color: '#123', width: 999 },
			highlighterState: null,
			colors: ['#abc', 'bad'],
			inkSmoothing: 4,
			pressureSensitivity: Number.NaN,
			paletteActivation: 'pencil-long-press',
			floatingPaletteButtonPosition: 'left',
		});

		expect(normalized.handedness).toBe('right');
		expect(normalized.toolState).toEqual(DEFAULT_SETTINGS.toolState);
		expect(normalized.penState).toEqual({
			color: '#123',
			width: DEFAULT_SETTINGS.penState.width,
		});
		expect(normalized.highlighterState).toEqual(DEFAULT_SETTINGS.highlighterState);
		expect(normalized.colors[0]).toBe('#abc');
		expect(normalized.colors[1]).toBe(DEFAULT_SETTINGS.colors[1]);
		expect(normalized.colors).toHaveLength(DEFAULT_SETTINGS.colors.length);
		expect(normalized.inkSmoothing).toBe(1);
		expect(normalized.pressureSensitivity).toBe(DEFAULT_SETTINGS.pressureSensitivity);
		expect(normalized.paletteActivation).toBe('pencil-double-tap-hold');
		expect(normalized.floatingPaletteButtonPosition).toBe('left');
	});
});
