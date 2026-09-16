export type PaletteActivation = 'two-finger' | 'pencil-long-press' | 'both';
export type FloatingPaletteButtonPosition = 'off' | 'left' | 'right';

export interface PalettePreferences {
	paletteActivation: PaletteActivation;
	pencilLongPressMs: number;
	floatingPaletteButtonPosition: FloatingPaletteButtonPosition;
}

export const MIN_PENCIL_LONG_PRESS_MS = 250;
export const MAX_PENCIL_LONG_PRESS_MS = 1000;

export const DEFAULT_PALETTE_PREFERENCES: PalettePreferences = {
	paletteActivation: 'two-finger',
	pencilLongPressMs: 300,
	floatingPaletteButtonPosition: 'right',
};

export function usesPencilLongPress(activation: PaletteActivation): boolean {
	return activation === 'pencil-long-press' || activation === 'both';
}

export function usesTwoFingerHold(activation: PaletteActivation): boolean {
	return activation === 'two-finger' || activation === 'both';
}

export function normalizePalettePreferences(
	stored: Partial<PalettePreferences> | null | undefined,
	preserveLegacyBehavior = false,
): PalettePreferences {
	const paletteActivation = isPaletteActivation(stored?.paletteActivation)
		? stored.paletteActivation
		: preserveLegacyBehavior
			? 'both'
			: DEFAULT_PALETTE_PREFERENCES.paletteActivation;
	const floatingPaletteButtonPosition = isFloatingPaletteButtonPosition(
		stored?.floatingPaletteButtonPosition,
	)
		? stored.floatingPaletteButtonPosition
		: preserveLegacyBehavior
			? 'off'
			: DEFAULT_PALETTE_PREFERENCES.floatingPaletteButtonPosition;
	const rawLongPressMs = stored?.pencilLongPressMs;
	const pencilLongPressMs =
		typeof rawLongPressMs === 'number' && Number.isFinite(rawLongPressMs)
			? Math.min(
					MAX_PENCIL_LONG_PRESS_MS,
					Math.max(MIN_PENCIL_LONG_PRESS_MS, Math.round(rawLongPressMs)),
				)
			: DEFAULT_PALETTE_PREFERENCES.pencilLongPressMs;

	return {
		paletteActivation,
		pencilLongPressMs,
		floatingPaletteButtonPosition,
	};
}

function isPaletteActivation(value: unknown): value is PaletteActivation {
	return value === 'two-finger' || value === 'pencil-long-press' || value === 'both';
}

function isFloatingPaletteButtonPosition(value: unknown): value is FloatingPaletteButtonPosition {
	return value === 'off' || value === 'left' || value === 'right';
}
