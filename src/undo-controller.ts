import type { OverlayManager } from './overlay-manager';
import type { StrokeStore } from './stroke-store';
import type { UndoEntry, UndoHistory } from './undo';

export interface UndoControllerCallbacks {
	activePdfPath: () => string | null;
	onAfterApply: (pdfPath: string) => void;
}

export class UndoController {
	constructor(
		private history: UndoHistory,
		private strokes: StrokeStore,
		private overlays: OverlayManager,
		private callbacks: UndoControllerCallbacks,
	) {}

	push(entry: UndoEntry): void {
		this.history.push(entry);
	}

	canUndo(): boolean {
		const path = this.callbacks.activePdfPath();
		return path !== null && this.history.canUndo(path);
	}

	canRedo(): boolean {
		const path = this.callbacks.activePdfPath();
		return path !== null && this.history.canRedo(path);
	}

	undo(): void {
		const path = this.callbacks.activePdfPath();
		if (!path) return;
		const entry = this.history.popUndo(path, (key) => this.strokes.forKey(key));
		if (entry) this.applyEntry(path, entry);
	}

	redo(): void {
		const path = this.callbacks.activePdfPath();
		if (!path) return;
		const entry = this.history.popRedo(path, (key) => this.strokes.forKey(key));
		if (entry) this.applyEntry(path, entry);
	}

	/**
	 * Revert a gesture stroke without creating a redo entry. The page key must
	 * match the newest undo entry, which prevents an old user action from being
	 * removed if the gesture state ever becomes stale.
	 */
	discardLatestTransient(pdfPath: string, key: string): boolean {
		const entry = this.history.discardLatestMatching(pdfPath, key);
		if (!entry) return false;
		this.applyEntry(pdfPath, entry);
		return true;
	}

	private applyEntry(pdfPath: string, entry: UndoEntry): void {
		this.strokes.setForKey(entry.key, [...entry.prevStrokes]);
		const canvas = this.overlays.overlayForKey(entry.key);
		if (canvas) this.overlays.redrawPage(canvas);
		this.callbacks.onAfterApply(pdfPath);
	}
}
