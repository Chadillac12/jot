import type { Stroke } from './stroke-math';

export const INK_KEY_ATTR = 'data-jot-key';

export interface InkSurfaceController {
	clearLivePage(canvas: HTMLCanvasElement): void;
	appendPersistedStroke(canvas: HTMLCanvasElement, stroke: Stroke): void;
	redrawPage(canvas: HTMLCanvasElement): void;
	overlayForKey(key: string): HTMLCanvasElement | null;
}

export interface InkSaveScheduler {
	scheduleSave(documentPath: string): void;
}
