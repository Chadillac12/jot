import { describe, expect, it } from 'vitest';
import {
	DEFAULT_PALETTE_PREFERENCES,
	normalizePalettePreferences,
	usesPencilDoubleTapHold,
	usesPencilLongPress,
	usesTwoFingerHold,
} from '../src/palette-activation';

describe('palette activation preferences', () => {
	it('defaults fresh settings to Pencil double-tap hold without taking over pinch zoom', () => {
		expect(normalizePalettePreferences({})).toEqual(DEFAULT_PALETTE_PREFERENCES);
		expect(usesPencilDoubleTapHold(DEFAULT_PALETTE_PREFERENCES.paletteActivation)).toBe(true);
		expect(usesPencilLongPress(DEFAULT_PALETTE_PREFERENCES.paletteActivation)).toBe(false);
		expect(usesTwoFingerHold(DEFAULT_PALETTE_PREFERENCES.paletteActivation)).toBe(false);
	});

	it('enables only Pencil long-press in pencil-long-press mode', () => {
		expect(usesPencilDoubleTapHold('pencil-long-press')).toBe(false);
		expect(usesPencilLongPress('pencil-long-press')).toBe(true);
		expect(usesTwoFingerHold('pencil-long-press')).toBe(false);
	});

	it('keeps two-finger hold available as an explicit legacy option', () => {
		expect(usesPencilDoubleTapHold('two-finger')).toBe(false);
		expect(usesPencilLongPress('two-finger')).toBe(false);
		expect(usesTwoFingerHold('two-finger')).toBe(true);
	});

	it('keeps legacy both mode as Pencil long-press plus two-finger hold', () => {
		expect(usesPencilDoubleTapHold('both')).toBe(false);
		expect(usesPencilLongPress('both')).toBe(true);
		expect(usesTwoFingerHold('both')).toBe(true);
	});

	it('preserves valid stored preferences and clamps a stored duration', () => {
		expect(
			normalizePalettePreferences({
				paletteActivation: 'pencil-double-tap-hold',
				pencilLongPressMs: 1200,
				floatingPaletteButtonPosition: 'left',
			}),
		).toEqual({
			paletteActivation: 'pencil-double-tap-hold',
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
