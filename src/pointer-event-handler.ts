import { readCanvasSurface } from './canvas-surface';
import { createHoldIndicator } from './hold-indicator';
import {
	normalizedPointFromSample,
	pointerSamples,
	predictedPointerSamples,
} from './ink-sampling';
import { documentPathFromKey } from './jot-file';
import { LongPressDetector } from './long-press';
import type { Handedness, Palette, ToolState } from './palette';
import {
	type PaletteActivation,
	usesPencilDoubleTapHold,
	usesTwoFingerHold,
} from './palette-activation';
import { INK_KEY_ATTR, type InkSaveScheduler, type InkSurfaceController } from './ink-surface';
import { PenStrokeState } from './pen-stroke-state';
import { ERASE_RADIUS, strokeIntersects } from './stroke-math';
import type { NormalizedPoint, Stroke, StrokeRenderProfile } from './stroke-math';
import { drawStroke } from './stroke-render';
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

interface CommittedStroke {
	stroke: Stroke;
	key: string;
	pdfPath: string | null;
	hasUndoEntry: boolean;
}

export interface PointerEventHandlerDeps {
	palette: Palette;
	strokes: StrokeStore;
	overlays: InkSurfaceController;
	sidecar: InkSaveScheduler;
	undo: UndoController;
	toolState: () => ToolState;
	handedness: () => Handedness;
	paletteActivation: () => PaletteActivation;
	renderProfile: () => StrokeRenderProfile;
	canEdit?: (documentPath: string) => boolean;
}

export class PointerEventHandler {
	private state = new PenStrokeState();
	private attached = false;
	private stylusBlocker: ((e: TouchEvent) => void) | null = null;
	private readonly pointerDownListener = (e: PointerEvent) => this.onPointerDown(e);
	private readonly pointerMoveListener = (e: PointerEvent) => this.onPointerMove(e);
	private readonly pointerUpListener = (e: PointerEvent) => this.onFinish(e);
	private readonly pointerCancelListener = (e: PointerEvent) => this.onCancel(e);
	private readonly lostCaptureListener = (e: PointerEvent) => this.onCancel(e);
	private activePointerId: number | null = null;
	private holdIndicator: HTMLElement | null = null;
	private twoFingerIndicator: HTMLElement | null = null;
	private longPress: LongPressDetector;
	private twoFingerHold: TwoFingerHoldDetector;
	private liveFrame: number | null = null;
	private predictedPoints: NormalizedPoint[] = [];

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

	attach(): () => void {
		if (this.attached) return () => this.detach();
		this.attached = true;
		this.blockStylusGesturePreemption();
		this.canvas.addEventListener('pointerdown', this.pointerDownListener);
		this.canvas.addEventListener('pointermove', this.pointerMoveListener);
		this.canvas.addEventListener('pointerup', this.pointerUpListener);
		this.canvas.addEventListener('pointercancel', this.pointerCancelListener);
		this.canvas.addEventListener('lostpointercapture', this.lostCaptureListener);
		return () => this.detach();
	}

	detach(): void {
		if (!this.attached) return;
		this.attached = false;
		this.canvas.removeEventListener('pointerdown', this.pointerDownListener);
		this.canvas.removeEventListener('pointermove', this.pointerMoveListener);
		this.canvas.removeEventListener('pointerup', this.pointerUpListener);
		this.canvas.removeEventListener('pointercancel', this.pointerCancelListener);
		this.canvas.removeEventListener('lostpointercapture', this.lostCaptureListener);
		if (this.stylusBlocker) {
			this.canvas.removeEventListener('touchstart', this.stylusBlocker);
			this.canvas.removeEventListener('touchmove', this.stylusBlocker);
			this.stylusBlocker = null;
		}
		this.longPress.cancel();
		this.twoFingerHold.cancel();
		this.cancelPencilDoubleTapHold();
		this.cancelLiveFrame();
		this.removeHoldIndicator();
		this.removeTwoFingerIndicator();
		this.predictedPoints = [];
		this.state.reset();
		this.releasePointerCapture();
	}

	private onPointerDown(e: PointerEvent): void {
		if (e.pointerType === 'touch') {
			if (usesTwoFingerHold(this.deps.paletteActivation())) {
				this.twoFingerHold.pointerDown(e.pointerId, e.clientX, e.clientY);
			} else {
				this.twoFingerHold.cancel();
			}
			return;
		}
		if (e.pointerType !== 'pen' && e.pointerType !== 'mouse') return;
		if (!this.canEditCurrentDocument()) {
			e.preventDefault();
			return;
		}
		if (this.deps.palette.isOpen()) return;

		this.cancelLiveFrame();
		this.deps.overlays.clearLivePage(this.canvas);
		// Pointer capture is helpful but not guaranteed in every WKWebView
		// state. A capture failure must not abort Pencil input entirely.
		try {
			this.canvas.setPointerCapture(e.pointerId);
		} catch {
			/* continue without capture */
		}
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
			const rect = this.canvas.getBoundingClientRect();
			this.state.appendDrawingPoint(normalizedPointFromSample(e, rect));
		}
		// Pencil is writing-only. A stylus pause must never turn into a palette
		// gesture or cancel a short stroke. Keep long-press available for mouse.
		if (e.pointerType === 'mouse') {
			this.showHoldIndicator(e.clientX, e.clientY, LONG_PRESS_MS);
			this.longPress.start(e.clientX, e.clientY);
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
		if (this.activePointerId !== e.pointerId) return;
		if (!this.canEditCurrentDocument()) {
			this.onCancel(e);
			e.preventDefault();
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

		if (e.pointerType === 'mouse') this.longPress.move(e.clientX, e.clientY);
		if (this.state.isErasing()) {
			if (this.eraseAtSamples(e)) this.state.markErased();
			e.preventDefault();
			return;
		}
		this.continueDrawingStroke(e);
	}

	private onCancel(e: PointerEvent): void {
		if (e.pointerType === 'touch') {
			this.twoFingerHold.pointerUp(e.pointerId);
			return;
		}
		if (this.activePointerId !== e.pointerId) return;

		// Cancellation is cleanup, not a mutation. It must always be allowed to
		// unwind an active gesture even if an exclusive operation acquired the
		// document lock after pointerdown.
		if (e.pointerType === 'mouse') this.longPress.cancel();
		if (
			e.pointerType === 'pen' &&
			this.isPencilSecondTapArmed() &&
			e.pointerId === this.secondTapPointerId
		) {
			this.cancelPencilDoubleTapHold();
		}

		this.predictedPoints = [];
		this.cancelLiveFrame();
		this.deps.overlays.clearLivePage(this.canvas);

		// Erasing mutates the store live for immediate visual feedback. If the
		// browser cancels the gesture, restore the pre-gesture snapshot so a
		// Safari/WebKit gesture arbitration event cannot delete ink.
		if (this.state.isErasing()) {
			const snapshot = this.state.takeEraserSnapshot();
			if (snapshot) {
				this.deps.strokes.setForKey(snapshot.key, [...snapshot.prevStrokes]);
				this.deps.overlays.redrawPage(this.canvas);
				this.deps.sidecar.scheduleSave(snapshot.pdfPath);
			}
		} else {
			// A cancelled pen stroke is transient and must never become persisted
			// ink or an undo entry.
			this.state.reset();
		}

		this.releasePointerCapture();
	}

	private onFinish(e: PointerEvent): void {
		if (e.pointerType === 'touch') {
			this.twoFingerHold.pointerUp(e.pointerId);
			return;
		}
		if (this.activePointerId !== e.pointerId) return;
		if (!this.canEditCurrentDocument()) {
			this.onCancel(e);
			e.preventDefault();
			return;
		}

		if (
			e.pointerType === 'pen' &&
			this.isPencilSecondTapArmed() &&
			e.pointerId === this.secondTapPointerId
		) {
			this.cancelPencilDoubleTapHold();
		}

		if (e.pointerType === 'mouse') this.longPress.cancel();
		const isQuickPencilTap = this.isQuickPencilTap(e);

		if (this.state.isErasing()) {
			const pushedUndo = this.finalizeEraserGesture();
			if (isQuickPencilTap) this.rememberPencilTap(e, pushedUndo);
			this.releasePointerCapture();
			return;
		}
		if (this.state.isDrawing()) {
			this.appendRealSamples(e);
			this.predictedPoints = [];
			this.cancelLiveFrame();
			const committed = this.finalizeDrawingStroke();
			// Commit only the new stroke underneath the live layer. Re-rendering
			// every previous freehand outline on each Pencil-up makes latency grow
			// with page complexity.
			if (committed) {
				this.deps.overlays.appendPersistedStroke(this.canvas, committed.stroke);
				if (isQuickPencilTap) {
					this.rememberPencilTap(
						e,
						committed.hasUndoEntry,
						committed.key,
						committed.pdfPath,
					);
				}
			}
			this.deps.overlays.clearLivePage(this.canvas);
		}
		this.releasePointerCapture();
	}

	private onLongPressFire(): void {
		this.removeHoldIndicator();
		const { clientX, clientY } = this.state.pressedAt;
		this.predictedPoints = [];
		this.cancelLiveFrame();
		this.state.reset();
		this.deps.overlays.clearLivePage(this.canvas);
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
		this.twoFingerIndicator = createHoldIndicator(this.canvas.ownerDocument, cx, cy, TWO_FINGER_HOLD_MS);
		this.canvas.ownerDocument.body.appendChild(this.twoFingerIndicator);
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
		if (
			age < 0 ||
			age > PENCIL_DOUBLE_TAP_GAP_MS ||
			distance > PENCIL_DOUBLE_TAP_DISTANCE_PX
		) {
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
		const win = this.canvas.ownerDocument.defaultView;
		if (!win) return;
		this.secondTapTimer = win.setTimeout(
			() => this.onPencilDoubleTapHoldFire(),
			PENCIL_SECOND_HOLD_MS,
		);
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
		this.predictedPoints = [];
		this.cancelLiveFrame();

		if (previous?.hasUndoEntry && previous.pdfPath && previous.key) {
			this.deps.undo.discardLatestTransient(previous.pdfPath, previous.key);
		}

		this.state.reset();
		this.deps.overlays.clearLivePage(this.canvas);
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
		const win = this.canvas.ownerDocument.defaultView;
		if (this.secondTapTimer !== null && win) win.clearTimeout(this.secondTapTimer);
		this.secondTapTimer = null;
	}

	private isPencilSecondTapArmed(): boolean {
		return this.secondTapPointerId !== null;
	}

	private isQuickPencilTap(e: PointerEvent): boolean {
		return (
			e.type === 'pointerup' &&
			e.pointerType === 'pen' &&
			usesPencilDoubleTapHold(this.deps.paletteActivation()) &&
			!this.penMovedBeyondTapThreshold &&
			Date.now() - this.penDownAtMs <= PENCIL_TAP_MAX_MS
		);
	}

	private rememberPencilTap(
		e: PointerEvent,
		hasUndoEntry: boolean,
		key = this.canvas.getAttribute(INK_KEY_ATTR),
		pdfPath = key ? documentPathFromKey(key) : null,
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

	private continueDrawingStroke(e: PointerEvent): void {
		if (!this.state.isDrawing()) return;
		const appended = this.appendRealSamples(e);
		const rect = this.canvas.getBoundingClientRect();
		const last = this.state.lastDrawingPoint();
		this.predictedPoints = last
			? predictedPointerSamples(e).map((sample) => ({
				...normalizedPointFromSample(sample, rect),
				pressure: last.pressure,
			}))
			: [];
		if (appended || this.predictedPoints.length > 0) {
			this.scheduleLiveRender();
			e.preventDefault();
		}
	}

	private appendRealSamples(e: PointerEvent): boolean {
		if (!this.state.isDrawing()) return false;
		const rect = this.canvas.getBoundingClientRect();
		let appended = false;
		for (const sample of pointerSamples(e)) {
			if (this.state.appendDrawingPoint(normalizedPointFromSample(sample, rect))) {
				appended = true;
			}
		}
		return appended;
	}

	private scheduleLiveRender(): void {
		if (this.liveFrame !== null) return;
		const win = this.canvas.ownerDocument.defaultView;
		if (!win) return;
		this.liveFrame = win.requestAnimationFrame(() => {
			this.liveFrame = null;
			this.renderLiveStroke();
		});
	}

	private renderLiveStroke(): void {
		if (!this.state.isDrawing()) {
			this.deps.overlays.clearLivePage(this.canvas);
			return;
		}
		const stored = this.state.drawingPoints();
		if (stored.length === 0) return;
		const points =
			this.predictedPoints.length > 0 ? [...stored, ...this.predictedPoints] : stored;
		const tool = this.deps.toolState();
		const surface = readCanvasSurface(this.canvas);
		this.deps.overlays.clearLivePage(this.canvas);
		drawStroke(
			this.ctx,
			{
				points,
				color: tool.color,
				width: tool.width,
				tool: tool.tool,
				render: this.deps.renderProfile(),
			},
			surface,
		);
	}

	private cancelLiveFrame(): void {
		if (this.liveFrame !== null) {
			this.canvas.ownerDocument.defaultView?.cancelAnimationFrame(this.liveFrame);
			this.liveFrame = null;
		}
	}

	private finalizeEraserGesture(): boolean {
		const snapshot = this.state.takeEraserSnapshot();
		if (snapshot) this.deps.undo.push(snapshot);
		this.state.reset();
		return snapshot !== null;
	}

	private finalizeDrawingStroke(): CommittedStroke | null {
		const points = this.state.drawingPoints();
		const key = this.canvas.getAttribute(INK_KEY_ATTR);
		let committed: CommittedStroke | null = null;
		if (key && points.length > 0) {
			const pdfPath = documentPathFromKey(key);
			const tool = this.deps.toolState();
			const hasUndoEntry = pdfPath !== null;
			if (pdfPath) {
				this.deps.undo.push({ pdfPath, key, prevStrokes: [...this.deps.strokes.forKey(key)] });
			}
			const stroke: Stroke = {
				points,
				color: tool.color,
				width: tool.width,
				tool: tool.tool,
				render: this.deps.renderProfile(),
			};
			this.deps.strokes.appendToKey(key, stroke);
			if (pdfPath) this.deps.sidecar.scheduleSave(pdfPath);
			committed = { stroke, key, pdfPath, hasUndoEntry };
		}
		this.state.reset();
		return committed;
	}

	private eraseAtSamples(e: PointerEvent): boolean {
		const key = this.canvas.getAttribute(INK_KEY_ATTR);
		if (!key) return false;
		const strokes = this.deps.strokes.forKey(key);
		if (strokes.length === 0) return false;
		const rect = this.canvas.getBoundingClientRect();
		const points = pointerSamples(e).map((sample) => normalizedPointFromSample(sample, rect));
		const aspectRatio = rect.height > 0 ? rect.width / rect.height : 1;
		const kept: Stroke[] = [];
		let removed = 0;
		for (const stroke of strokes) {
			const intersects = points.some((point) =>
				strokeIntersects(stroke, point.x, point.y, ERASE_RADIUS, aspectRatio),
			);
			if (intersects) {
				removed += 1;
			} else {
				kept.push(stroke);
			}
		}
		if (removed === 0) return false;
		this.deps.strokes.setForKey(key, kept);
		this.deps.overlays.redrawPage(this.canvas);
		const pdfPath = documentPathFromKey(key);
		if (pdfPath) this.deps.sidecar.scheduleSave(pdfPath);
		return true;
	}

	private snapshotCurrent() {
		const key = this.canvas.getAttribute(INK_KEY_ATTR);
		if (!key) return null;
		const pdfPath = documentPathFromKey(key);
		if (!pdfPath) return null;
		return { pdfPath, key, prevStrokes: [...this.deps.strokes.forKey(key)] };
	}

	private canEditCurrentDocument(): boolean {
		const key = this.canvas.getAttribute(INK_KEY_ATTR);
		const path = key ? documentPathFromKey(key) : null;
		return path === null || (this.deps.canEdit?.(path) ?? true);
	}

	private openPaletteAt(x: number, y: number): void {
		this.deps.palette.show(this.canvas.ownerDocument.body, x, y, this.deps.handedness());
	}

	private showHoldIndicator(x: number, y: number, durationMs: number): void {
		this.removeHoldIndicator();
		this.holdIndicator = createHoldIndicator(this.canvas.ownerDocument, x, y, durationMs);
		this.canvas.ownerDocument.body.appendChild(this.holdIndicator);
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


	private blockStylusGesturePreemption(): void {
		this.stylusBlocker = (e: TouchEvent) => {
			for (let i = 0; i < e.touches.length; i++) {
				const t = e.touches.item(i) as Touch & { touchType?: string };
				if (t?.touchType === 'stylus') {
					e.preventDefault();
					return;
				}
			}
		};
		this.canvas.addEventListener('touchstart', this.stylusBlocker, { passive: false });
		this.canvas.addEventListener('touchmove', this.stylusBlocker, { passive: false });
	}
}
