import { readCanvasSurface } from './canvas-surface';
import { createHoldIndicator } from './hold-indicator';
import { pdfPathFromKey } from './jot-file';
import { LongPressDetector } from './long-press';
import type { Handedness, Palette, ToolState } from './palette';
import {
	type PaletteActivation,
	usesPencilDoubleTapHold,
	usesPencilLongPress,
	usesTwoFingerHold,
} from './palette-activation';
import { OVERLAY_KEY_ATTR, OverlayManager } from './overlay-manager';
import { PenStrokeState } from './pen-stroke-state';
import type { SidecarStore } from './sidecar-store';
import {
	ERASE_RADIUS,
	NormalizedPoint,
	Stroke,
	strokeIntersects,
} from './stroke-math';
import { drawHighlighterPolyline, drawSegment } from './stroke-render';
import type { StrokeStore } from './stroke-store';
import { TwoFingerHoldDetector } from './two-finger-hold';
import type { UndoController } from './undo-controller';

const LONG_PRESS_MS = 300;
const LONG_PRESS_MOVE_PX = 15;
const TWO_FINGER_HOLD_MS = 300;
const TWO_FINGER_MOVE_PX = 25;

const PENCIL_TAP_MAX_MS = 220;
const PENCIL_TAP_MOVE_PX = 14;
const PENCIL_DOUBLE_TAP_GAP_MS = 320;
const PENCIL_DOUBLE_TAP_DISTANCE_PX = 36;
const PENCIL_SECOND_HOLD_MS = 280;

interface RecentPencilTap {
	releasedAtMs: number;
	clientX: number;
	clientY: number;
	pdfPath: string | null;
	key: string | null;
	hasUndoEntry: boolean;
}

export interface PointerEventHandlerDeps {
	palette: Palette;
	strokes: StrokeStore;
	overlays: OverlayManager;
	sidecar: SidecarStore;
	undo: UndoController;
	toolState: () => ToolState;
	handedness: () => Handedness;
	paletteActivation: () => PaletteActivation;
	pencilLongPressMs: () => number;
}

export class PointerEventHandler {
	private state = new PenStrokeState();
	private activePointerId: number | null = null;
	private holdIndicator: HTMLElement | null = null;
	private twoFingerIndicator: HTMLElement | null = null;
	private longPress: LongPressDetector;
	private twoFingerHold: TwoFingerHoldDetector;

	private penDownAtMs = 0;
	private penDownX = 0;
	private penDownY = 0;
	private penMovedBeyondTapThreshold = false;
	private recentPencilTap: RecentPencilTap | null = null;
	private secondTapPointerId: number | null = null;
	private secondTapX = 0;
	private secondTapY = 0;
	private secondTapTimer: number | null = null;

	constructor(
		private canvas: HTMLCanvasElement,
		private ctx: CanvasRenderingContext2D,
		private deps: PointerEventHandlerDeps,
	) {
		this.longPress = new LongPressDetector(
			{ durationMs: LONG_PRESS_MS, movementThresholdPx: LONG_PRESS_MOVE_PX },
			{
				onFire: () => this.onLongPressFire(),
				onCancel: () => this.removeHoldIndicator(),
			},
		);
		this.twoFingerHold = new TwoFingerHoldDetector(
			{ durationMs: TWO_FINGER_HOLD_MS, movementThresholdPx: TWO_FINGER_MOVE_PX },
			{
				onArm: (cx, cy) => this.onTwoFingerArm(cx, cy),
				onFire: (cx, cy) => this.onTwoFingerFire(cx, cy),
				onDisarm: () => this.removeTwoFingerIndicator(),
			},
		);
	}

	attach(): void {
		this.blockStylusGesturePreemption();
		this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
		this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
		this.canvas.addEventListener('pointerup', (e) => this.onFinish(e));
		this.canvas.addEventListener('pointercancel', (e) => this.onFinish(e));
	}

	private onPointerDown(e: PointerEvent): void {
		if (e.pointerType === 'touch') {
			if (usesTwoFingerHold(this.deps.paletteActivation())) {
				this.twoFingerHold.pointerDown(e.pointerId, e.clientX, e.clientY);
			}
			return;
		}
		if (e.pointerType !== 'pen' && e.pointerType !== 'mouse') return;
		if (this.deps.palette.isOpen()) return;

		this.canvas.setPointerCapture(e.pointerId);
		this.activePointerId = e.pointerId;

		if (e.pointerType === 'pen') {
			this.penDownAtMs = Date.now();
			this.penDownX = e.clientX;
			this.penDownY = e.clientY;
			this.penMovedBeyondTapThreshold = false;
			if (this.isSecondTapCandidate(e)) this.armPencilDoubleTapHold(e);
		}

		this.state.beginAt(e, this.deps.toolState().tool, () => this.snapshotCurrent());
		if (this.state.isDrawing()) {
			this.state.appendDrawingPoint(this.toNormalized(e));
		}
		if (!this.isPencilSecondTapArmed() && this.shouldArmLongPress(e.pointerType)) {
			const durationMs = this.deps.pencilLongPressMs();
			this.showHoldIndicator(e.clientX, e.clientY, durationMs);
			this.longPress.start(e.clientX, e.clientY, durationMs);
		}
		e.preventDefault();
	}

	private onPointerMove(e: PointerEvent): void {
		if (e.pointerType === 'touch') {
			if (usesTwoFingerHold(this.deps.paletteActivation())) {
				this.twoFingerHold.pointerMove(e.pointerId, e.clientX, e.clientY);
			} else {
				this.twoFingerHold.cancel();
			}
			return;
		}

		if (e.pointerType === 'pen') {
			const moved = Math.hypot(e.clientX - this.penDownX, e.clientY - this.penDownY);
			if (moved > PENCIL_TAP_MOVE_PX) this.penMovedBeyondTapThreshold = true;

			if (this.isPencilSecondTapArmed() && e.pointerId === this.secondTapPointerId) {
				const secondMove = Math.hypot(e.clientX - this.secondTapX, e.clientY - this.secondTapY);
				if (secondMove <= PENCIL_TAP_MOVE_PX) {
					e.preventDefault();
					return;
				}
				this.cancelPencilDoubleTapHold();
			}
		}

		this.longPress.move(e.clientX, e.clientY);
		if (this.state.isErasing()) {
			if (this.eraseAt(e)) this.state.markErased();
			e.preventDefault();
			return;
		}
		this.continueDrawingStroke(e);
	}

	private onFinish(e: PointerEvent): void {
		if (e.pointerType === 'touch') {
			this.twoFingerHold.pointerUp(e.pointerId);
			return;
		}

		if (e.pointerType === 'pen' && this.isPencilSecondTapArmed() && e.pointerId === this.secondTapPointerId) {
			this.cancelPencilDoubleTapHold();
		}

		this.longPress.cancel();
		const isQuickPencilTap = this.isQuickPencilTap(e);

		if (this.state.isErasing()) {
			const pushedUndo = this.finalizeEraserGesture();
			if (isQuickPencilTap) this.rememberPencilTap(e, pushedUndo);
			this.releasePointerCapture();
			return;
		}
		if (this.state.isDrawing()) {
			const committed = this.finalizeDrawingStroke();
			if (isQuickPencilTap && committed) {
				this.rememberPencilTap(e, committed.hasUndoEntry, committed.key, committed.pdfPath);
			}
			window.requestAnimationFrame(() => this.deps.overlays.redrawPage(this.canvas));
		}
		this.releasePointerCapture();
	}

	private onLongPressFire(): void {
		this.removeHoldIndicator();
		const { clientX, clientY } = this.state.pressedAt;
		this.state.reset();
		this.deps.overlays.redrawPage(this.canvas);
		this.releasePointerCapture();
		this.openPaletteAt(clientX, clientY);
	}

	private onTwoFingerArm(cx: number, cy: number): void {
		if (
			!usesTwoFingerHold(this.deps.paletteActivation()) ||
			this.deps.palette.isOpen() ||
			this.state.isBusy()
		) {
			this.twoFingerHold.cancel();
			return;
		}
		this.twoFingerIndicator = createHoldIndicator(activeDocument, cx, cy, TWO_FINGER_HOLD_MS);
		activeDocument.body.appendChild(this.twoFingerIndicator);
	}

	private onTwoFingerFire(cx: number, cy: number): void {
		this.removeTwoFingerIndicator();
		if (!usesTwoFingerHold(this.deps.paletteActivation()) || this.deps.palette.isOpen()) return;
		this.openPaletteAt(cx, cy);
	}

	private isSecondTapCandidate(e: PointerEvent): boolean {
		if (!usesPencilDoubleTapHold(this.deps.paletteActivation())) return false;
		const previous = this.recentPencilTap;
		if (!previous) return false;
		const age = Date.now() - previous.releasedAtMs;
		const distance = Math.hypot(e.clientX - previous.clientX, e.clientY - previous.clientY);
		if (age < 0 || age > PENCIL_DOUBLE_TAP_GAP_MS || distance > PENCIL_DOUBLE_TAP_DISTANCE_PX) {
			this.recentPencilTap = null;
			return false;
		}
		return true;
	}

	private armPencilDoubleTapHold(e: PointerEvent): void {
		this.secondTapPointerId = e.pointerId;
		this.secondTapX = e.clientX;
		this.secondTapY = e.clientY;
		this.showHoldIndicator(e.clientX, e.clientY, PENCIL_SECOND_HOLD_MS);
		this.secondTapTimer = window.setTimeout(() => this.onPencilDoubleTapHoldFire(), PENCIL_SECOND_HOLD_MS);
	}

	private onPencilDoubleTapHoldFire(): void {
		if (!this.isPencilSecondTapArmed()) return;
		const previous = this.recentPencilTap;
		const x = this.secondTapX;
		const y = this.secondTapY;

		this.clearSecondTapTimer();
		this.secondTapPointerId = null;
		this.removeHoldIndicator();
		this.recentPencilTap = null;
		this.longPress.cancel();

		if (previous?.hasUndoEntry && previous.pdfPath && previous.key) {
			this.deps.undo.discardLatestTransient(previous.pdfPath, previous.key);
		}

		this.state.reset();
		this.deps.overlays.redrawPage(this.canvas);
		this.releasePointerCapture();
		this.openPaletteAt(x, y);
	}

	private cancelPencilDoubleTapHold(): void {
		this.clearSecondTapTimer();
		this.secondTapPointerId = null;
		this.removeHoldIndicator();
		this.recentPencilTap = null;
	}

	private clearSecondTapTimer(): void {
		if (this.secondTapTimer !== null) window.clearTimeout(this.secondTapTimer);
		this.secondTapTimer = null;
	}

	private isPencilSecondTapArmed(): boolean {
		return this.secondTapPointerId !== null;
	}

	private isQuickPencilTap(e: PointerEvent): boolean {
		return (
			e.pointerType === 'pen' &&
			usesPencilDoubleTapHold(this.deps.paletteActivation()) &&
			!this.penMovedBeyondTapThreshold &&
			Date.now() - this.penDownAtMs <= PENCIL_TAP_MAX_MS
		);
	}

	private rememberPencilTap(
		e: PointerEvent,
		hasUndoEntry: boolean,
		key = this.canvas.getAttribute(OVERLAY_KEY_ATTR),
		pdfPath = key ? pdfPathFromKey(key) : null,
	): void {
		this.recentPencilTap = {
			releasedAtMs: Date.now(),
			clientX: e.clientX,
			clientY: e.clientY,
			pdfPath,
			key,
			hasUndoEntry,
		};
	}

	private shouldArmLongPress(pointerType: string): boolean {
		// Preserve the existing desktop mouse gesture. The preference controls
		// Apple Pencil/stylus activation only.
		return pointerType === 'mouse' || usesPencilLongPress(this.deps.paletteActivation());
	}

	private continueDrawingStroke(e: PointerEvent): void {
		if (!this.state.isDrawing()) return;
		const previous = this.state.lastDrawingPoint();
		if (!previous) return;
		const next = this.toNormalized(e);
		this.state.appendDrawingPoint(next);
		const surface = readCanvasSurface(this.canvas);
		const tool = this.deps.toolState();
		if (tool.tool === 'highlighter') {
			this.deps.overlays.redrawPage(this.canvas);
			drawHighlighterPolyline(this.ctx, this.state.drawingPoints(), tool.color, tool.width, surface);
		} else {
			drawSegment(this.ctx, previous, next, tool.color, tool.width, surface);
		}
		e.preventDefault();
	}

	private finalizeEraserGesture(): boolean {
		const snapshot = this.state.takeEraserSnapshot();
		if (snapshot) this.deps.undo.push(snapshot);
		this.state.reset();
		return snapshot !== null;
	}

	private finalizeDrawingStroke(): {
		key: string;
		pdfPath: string | null;
		hasUndoEntry: boolean;
	} | null {
		const points = this.state.drawingPoints();
		const key = this.canvas.getAttribute(OVERLAY_KEY_ATTR);
		let result: { key: string; pdfPath: string | null; hasUndoEntry: boolean } | null = null;
		if (key && points.length > 0) {
			const pdfPath = pdfPathFromKey(key);
			const tool = this.deps.toolState();
			if (pdfPath) {
				this.deps.undo.push({ pdfPath, key, prevStrokes: [...this.deps.strokes.forKey(key)] });
			}
			this.deps.strokes.appendToKey(key, {
				points,
				color: tool.color,
				width: tool.width,
				tool: tool.tool,
			});
			if (pdfPath) this.deps.sidecar.scheduleSave(pdfPath);
			result = { key, pdfPath, hasUndoEntry: pdfPath !== null };
		}
		this.state.reset();
		return result;
	}

	private eraseAt(e: PointerEvent): boolean {
		const key = this.canvas.getAttribute(OVERLAY_KEY_ATTR);
		if (!key) return false;
		const strokes = this.deps.strokes.forKey(key);
		if (strokes.length === 0) return false;
		const rect = this.canvas.getBoundingClientRect();
		const x = (e.clientX - rect.left) / rect.width;
		const y = (e.clientY - rect.top) / rect.height;
		const kept: Stroke[] = [];
		let removed = 0;
		for (const stroke of strokes) {
			if (strokeIntersects(stroke, x, y, ERASE_RADIUS)) {
				removed += 1;
			} else {
				kept.push(stroke);
			}
		}
		if (removed === 0) return false;
		this.deps.strokes.setForKey(key, kept);
		this.deps.overlays.redrawPage(this.canvas);
		const pdfPath = pdfPathFromKey(key);
		if (pdfPath) this.deps.sidecar.scheduleSave(pdfPath);
		return true;
	}

	private snapshotCurrent() {
		const key = this.canvas.getAttribute(OVERLAY_KEY_ATTR);
		if (!key) return null;
		const pdfPath = pdfPathFromKey(key);
		if (!pdfPath) return null;
		return { pdfPath, key, prevStrokes: [...this.deps.strokes.forKey(key)] };
	}

	private openPaletteAt(x: number, y: number): void {
		this.deps.palette.show(activeDocument.body, x, y, this.deps.handedness());
	}

	private showHoldIndicator(x: number, y: number, durationMs: number): void {
		this.removeHoldIndicator();
		this.holdIndicator = createHoldIndicator(activeDocument, x, y, durationMs);
		activeDocument.body.appendChild(this.holdIndicator);
	}

	private removeHoldIndicator(): void {
		this.holdIndicator?.remove();
		this.holdIndicator = null;
	}

	private removeTwoFingerIndicator(): void {
		this.twoFingerIndicator?.remove();
		this.twoFingerIndicator = null;
	}

	private releasePointerCapture(): void {
		if (this.activePointerId === null) return;
		try {
			this.canvas.releasePointerCapture(this.activePointerId);
		} catch {
			/* already released */
		}
		this.activePointerId = null;
	}

	private toNormalized(e: PointerEvent): NormalizedPoint {
		const rect = this.canvas.getBoundingClientRect();
		return {
			x: (e.clientX - rect.left) / rect.width,
			y: (e.clientY - rect.top) / rect.height,
			pressure: e.pressure,
		};
	}

	private blockStylusGesturePreemption(): void {
		const blockStylus = (e: TouchEvent) => {
			for (let i = 0; i < e.touches.length; i++) {
				const t = e.touches.item(i) as Touch & { touchType?: string };
				if (t?.touchType === 'stylus') {
					e.preventDefault();
					return;
				}
			}
		};
		this.canvas.addEventListener('touchstart', blockStylus, { passive: false });
		this.canvas.addEventListener('touchmove', blockStylus, { passive: false });
	}
}
