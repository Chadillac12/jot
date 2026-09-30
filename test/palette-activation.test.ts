import { describe, expect, it } from 'vitest';
import {
	DEFAULT_PALETTE_PREFERENCES,
	normalizePalettePreferences,
	usesPencilDoubleTapHold,
	usesTwoFingerHold,
} from '../src/palette-activation';

describe('palette activation preferences', () => {
	it('defaults to Pencil double-tap hold without taking over pinch zoom', () => {
		expect(normalizePalettePreferences({})).toEqual(DEFAULT_PALETTE_PREFERENCES);
		expect(usesPencilDoubleTapHold(DEFAULT_PALETTE_PREFERENCES.paletteActivation)).toBe(true);
		expect(usesTwoFingerHold(DEFAULT_PALETTE_PREFERENCES.paletteActivation)).toBe(false);
	});

	it('keeps two-finger hold available when explicitly selected', () => {
		expect(usesPencilDoubleTapHold('two-finger')).toBe(false);
		expect(usesTwoFingerHold('two-finger')).toBe(true);
	});

	it('allows both safe gestures together', () => {
		expect(usesPencilDoubleTapHold('both')).toBe(true);
		expect(usesTwoFingerHold('both')).toBe(true);
	});

	it('migrates the old Pencil long-press preference to double-tap hold', () => {
		expect(
			normalizePalettePreferences({
				paletteActivation: 'pencil-long-press',
				floatingPaletteButtonPosition: 'left',
			} as never),
		).toEqual({
			paletteActivation: 'pencil-double-tap-hold',
			floatingPaletteButtonPosition: 'left',
		});
	});
});
