import { describe, expect, it } from 'vitest';
import {
	DEFAULT_PALETTE_PREFERENCES,
	normalizePalettePreferences,
	usesPencilLongPress,
	usesTwoFingerHold,
} from '../src/palette-activation';

describe('palette activation preferences', () => {
	it('defaults fresh settings to two-finger hold with Pencil long-press disabled', () => {
		expect(normalizePalettePreferences({})).toEqual(DEFAULT_PALETTE_PREFERENCES);
		expect(usesPencilLongPress(DEFAULT_PALETTE_PREFERENCES.paletteActivation)).toBe(false);
		expect(usesTwoFingerHold(DEFAULT_PALETTE_PREFERENCES.paletteActivation)).toBe(true);
	});

	it('enables only Pencil long-press in pencil-long-press mode', () => {
		expect(usesPencilLongPress('pencil-long-press')).toBe(true);
		expect(usesTwoFingerHold('pencil-long-press')).toBe(false);
	});

	it('enables both activation mechanisms in both mode', () => {
		expect(usesPencilLongPress('both')).toBe(true);
		expect(usesTwoFingerHold('both')).toBe(true);
	});

	it('preserves valid stored preferences and clamps a stored duration', () => {
		expect(
			normalizePalettePreferences({
				paletteActivation: 'both',
				pencilLongPressMs: 1200,
				floatingPaletteButtonPosition: 'left',
			}),
		).toEqual({
			paletteActivation: 'both',
			pencilLongPressMs: 1000,
			floatingPaletteButtonPosition: 'left',
		});
	});

	it('preserves legacy Jot activation when migrating an existing settings object', () => {
		const migrated = normalizePalettePreferences({}, true);
		expect(migrated.paletteActivation).toBe('both');
		expect(migrated.floatingPaletteButtonPosition).toBe('off');
		expect(migrated.pencilLongPressMs).toBe(300);
	});
});
