import type { InkSurfaceController } from './ink-surface';
import type { StrokeStore } from './stroke-store';
import type { UndoEntry, UndoHistory } from './undo';

export interface UndoControllerCallbacks {
	activeDocumentPath: () => string | null;
	onAfterApply: (documentPath: string) => void;
	canMutate?: (documentPath: string) => boolean;
}

export class UndoController {
	constructor(
		private history: UndoHistory,
		private strokes: StrokeStore,
		private overlays: InkSurfaceController,
		private callbacks: UndoControllerCallbacks,
	) {}

	push(entry: UndoEntry): void {
		this.history.push(entry);
	}

	canUndo(): boolean {
		const path = this.callbacks.activeDocumentPath();
		return (
			path !== null &&
			(this.callbacks.canMutate?.(path) ?? true) &&
			this.history.canUndo(path)
		);
	}

	canRedo(): boolean {
		const path = this.callbacks.activeDocumentPath();
		return (
			path !== null &&
			(this.callbacks.canMutate?.(path) ?? true) &&
			this.history.canRedo(path)
		);
	}

	undo(): void {
		const path = this.callbacks.activeDocumentPath();
		if (!path || !(this.callbacks.canMutate?.(path) ?? true)) return;
		const entry = this.history.popUndo(path, (key) => this.strokes.forKey(key));
		if (entry) this.applyEntry(path, entry);
	}

	redo(): void {
		const path = this.callbacks.activeDocumentPath();
		if (!path || !(this.callbacks.canMutate?.(path) ?? true)) return;
		const entry = this.history.popRedo(path, (key) => this.strokes.forKey(key));
		if (entry) this.applyEntry(path, entry);
	}

	/**
	 * Revert a gesture stroke without creating a redo entry. The page key must
	 * match the newest undo entry, which prevents an old user action from being
	 * removed if the gesture state ever becomes stale.
	 */
	discardLatestTransient(documentPath: string, key: string): boolean {
		if (!(this.callbacks.canMutate?.(documentPath) ?? true)) return false;
		const entry = this.history.discardLatestMatching(documentPath, key);
		if (!entry) return false;
		this.applyEntry(documentPath, entry);
		return true;
	}

	private applyEntry(documentPath: string, entry: UndoEntry): void {
		this.strokes.setForKey(entry.key, [...entry.prevStrokes]);
		const canvas = this.overlays.overlayForKey(entry.key);
		if (canvas) this.overlays.redrawPage(canvas);
		this.callbacks.onAfterApply(documentPath);
	}
}
