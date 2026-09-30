export type PaletteActivation =
	| 'pencil-double-tap-hold'
	| 'two-finger'
	| 'both';

export type FloatingPaletteButtonPosition = 'off' | 'left' | 'right';

export interface PalettePreferences {
	paletteActivation: PaletteActivation;
	floatingPaletteButtonPosition: FloatingPaletteButtonPosition;
}

export const DEFAULT_PALETTE_PREFERENCES: PalettePreferences = {
	paletteActivation: 'pencil-double-tap-hold',
	floatingPaletteButtonPosition: 'right',
};

export function usesPencilDoubleTapHold(activation: PaletteActivation): boolean {
	return activation === 'pencil-double-tap-hold' || activation === 'both';
}

export function usesTwoFingerHold(activation: PaletteActivation): boolean {
	return activation === 'two-finger' || activation === 'both';
}

/**
 * Migrate older palette preferences without ever re-enabling Pencil
 * single-long-press. That gesture conflicts with normal handwriting.
 */
export function normalizePalettePreferences(
	stored:
		| Partial<PalettePreferences> & { paletteActivation?: string }
		| null
		| undefined,
): PalettePreferences {
	let paletteActivation: PaletteActivation = DEFAULT_PALETTE_PREFERENCES.paletteActivation;
	if (stored?.paletteActivation === 'two-finger') {
		paletteActivation = 'two-finger';
	} else if (stored?.paletteActivation === 'both') {
		paletteActivation = 'both';
	} else if (stored?.paletteActivation === 'pencil-double-tap-hold') {
		paletteActivation = 'pencil-double-tap-hold';
	}
	// Legacy pencil-long-press intentionally migrates to the safe Pencil gesture.

	const floatingPaletteButtonPosition =
		stored?.floatingPaletteButtonPosition === 'off' ||
		stored?.floatingPaletteButtonPosition === 'left' ||
		stored?.floatingPaletteButtonPosition === 'right'
			? stored.floatingPaletteButtonPosition
			: DEFAULT_PALETTE_PREFERENCES.floatingPaletteButtonPosition;

	return { paletteActivation, floatingPaletteButtonPosition };
}
