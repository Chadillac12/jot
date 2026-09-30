import { PressureSmoother } from './ink-sampling';
import type { NormalizedPoint } from './stroke-math';
import type { Tool } from './palette';
import type { UndoEntry } from './undo';

export class PenStrokeState {
	private drawing: NormalizedPoint[] | null = null;
	private eraserActive = false;
	private eraserSnapshot: UndoEntry | null = null;
	private eraserTouched = false;
	private pressure = new PressureSmoother();
	pressedAt = { clientX: 0, clientY: 0 };

	beginAt(e: PointerEvent, tool: Tool, snapshotForEraser: () => UndoEntry | null): void {
		this.pressedAt = { clientX: e.clientX, clientY: e.clientY };
		this.pressure.reset();
		if (tool === 'eraser') {
			this.eraserActive = true;
			this.eraserTouched = false;
			this.eraserSnapshot = snapshotForEraser();
		} else {
			this.drawing = [];
		}
	}

	isDrawing(): boolean {
		return this.drawing !== null;
	}

	isErasing(): boolean {
		return this.eraserActive;
	}

	isBusy(): boolean {
		return this.isDrawing() || this.isErasing();
	}

	/**
	 * Append a point with lightly filtered pressure. Returns the actual stored
	 * point so the live renderer and persisted stroke use identical data.
	 */
	appendDrawingPoint(point: NormalizedPoint): NormalizedPoint | null {
		if (!this.drawing) return null;
		const filtered = {
			...point,
			pressure: this.pressure.next(point.pressure),
		};
		const previous = this.drawing[this.drawing.length - 1];
		if (previous && previous.x === filtered.x && previous.y === filtered.y) {
			return null;
		}
		this.drawing.push(filtered);
		return filtered;
	}

	drawingPoints(): NormalizedPoint[] {
		return this.drawing ?? [];
	}

	lastDrawingPoint(): NormalizedPoint | null {
		const list = this.drawing;
		if (!list || list.length === 0) return null;
		return list[list.length - 1] ?? null;
	}

	markErased(): void {
		this.eraserTouched = true;
	}

	takeEraserSnapshot(): UndoEntry | null {
		const snapshot = this.eraserTouched ? this.eraserSnapshot : null;
		this.eraserSnapshot = null;
		this.eraserTouched = false;
		this.eraserActive = false;
		return snapshot;
	}

	reset(): void {
		this.drawing = null;
		this.eraserActive = false;
		this.eraserSnapshot = null;
		this.eraserTouched = false;
		this.pressure.reset();
	}
}
