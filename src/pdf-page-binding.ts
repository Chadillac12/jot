import {
	applyBackingStoreSize,
	type CanvasBackingStoreLimits,
	devicePixelRatioFor,
	readCanvasSurface,
	safeBackingStoreDpr,
} from './canvas-surface';
import { INK_KEY_ATTR } from './ink-surface';
import {
	NULL_DIAGNOSTICS,
	type DiagnosticSink,
} from './persistent-diagnostics';
import { drawStroke } from './stroke-render';
import type { StrokeStore } from './stroke-store';

export const PDF_OVERLAY_CLASS = 'jot-overlay';
export const PDF_LIVE_OVERLAY_CLASS = 'jot-live-overlay';
export const PDF_PAGE_ANCHOR_CLASS = 'jot-page-anchor';
export const PDF_PASSTHROUGH_CLASS = 'jot-passthrough';
export const PDF_DORMANT_INPUT_CLASS = 'jot-live-overlay-dormant';

export const PDF_OVERLAY_BACKING_STORE_LIMITS: CanvasBackingStoreLimits = {
	maxDimension: 2048,
	maxArea: 2_500_000,
};

const PDF_OVERLAY_RECOVERY_DELAY_MS = 150;
const PDF_OVERLAY_DEACTIVATION_GRACE_MS = 750;

export type PdfPointerForwarder = (event: PointerEvent) => void;
export type PdfLiveWiring = (
	canvas: HTMLCanvasElement,
	registerForwarder?: (forwarder: PdfPointerForwarder | null) => void,
) => (() => void) | null | void;

export interface PdfPageBindingOptions {
	observerRoot?: Element;
	rootMargin?: string;
	backingStoreLimits?: CanvasBackingStoreLimits;
	recoveryDelayMs?: number;
	deactivationGraceMs?: number;
}

export class PdfPageBinding {
	private persistent: HTMLCanvasElement | null = null;
	private live: HTMLCanvasElement | null = null;
	private liveDisposer: (() => void) | null = null;
	private mutationObserver: MutationObserver | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private intersectionObserver: IntersectionObserver | null = null;
	private resizeFrame: number | null = null;
	private recoveryTimer: number | null = null;
	private deactivationTimer: number | null = null;
	private active = false;
	private nearViewport = false;
	private activePointerId: number | null = null;
	private pointerForwarder: PdfPointerForwarder | null = null;
	private contextRetryCount = 0;
	private disposed = false;
	private readonly handleInputPointerDown = (event: PointerEvent) => {
		if (event.pointerType !== 'pen' && event.pointerType !== 'mouse') return;
		const originalTargetWasLive = event.target === this.live;
		if (this.diagnostics.isEnabled()) {
			this.diagnostics.record('pdf.input-pointerdown', {
				key: this.keyValue,
				pointerType: event.pointerType,
				source: originalTargetWasLive ? 'live-canvas' : 'page-fallback',
				active: this.active,
				liveAttached: this.liveInputAttached(),
			});
		}
		this.cancelDeactivate();
		// A later Pencil contact may retry after an earlier bounded failure.
		if (this.contextRetryCount >= 5) this.contextRetryCount = 0;
		this.activate('input');
		// Canvas replacement can clear an old pointer pin. Claim the new ID
		// only after activation/replacement has completed.
		this.activePointerId = event.pointerId;
		if (!originalTargetWasLive) {
			if (this.pointerForwarder) {
				this.pointerForwarder(event);
				this.diagnostics.record('pdf.input-forwarded', { key: this.keyValue, phase: 'down' });
			} else {
				this.diagnostics.record('pdf.input-unavailable', { key: this.keyValue, reason: 'no-live-handler' });
				this.activePointerId = null;
				if (!this.nearViewport) this.scheduleDeactivate();
			}
		}
	};
	private readonly handleInputPointerContinuation = (event: PointerEvent) => {
		if (event.pointerId !== this.activePointerId) return;
		if (event.target !== this.live) {
			this.pointerForwarder?.(event);
			if (!this.pointerForwarder && event.type !== 'pointermove') {
				this.diagnostics.record('pdf.input-unavailable', { key: this.keyValue, reason: 'lost-forwarder', phase: event.type });
			}
		}
		if (event.type === 'pointerup' || event.type === 'pointercancel' ||
			event.type === 'lostpointercapture') this.finishInputPointer(event);
	};
	private readonly handleInputPointerEnd = (event: PointerEvent) => {
		this.finishInputPointer(event);
	};
	private finishInputPointer(event: PointerEvent): void {
		if (event.pointerType !== 'pen' && event.pointerType !== 'mouse') return;
		if (event.pointerId !== this.activePointerId) return;
		this.activePointerId = null;
		if (!this.nearViewport) this.scheduleDeactivate();
	}

	constructor(
		private page: HTMLElement,
		private keyValue: string,
		private strokes: StrokeStore,
		private wireLiveCanvas: PdfLiveWiring,
		private diagnostics: DiagnosticSink = NULL_DIAGNOSTICS,
		private options: PdfPageBindingOptions = {},
	) {}

	get key(): string {
		return this.keyValue;
	}

	mount(): void {
		if (this.disposed) return;
		this.diagnostics.record('pdf.page-binding-mount', {
			key: this.keyValue,
			pageNumber: this.page.getAttribute('data-page-number'),
		});
		this.page.classList.add(PDF_PAGE_ANCHOR_CLASS);
		// Parent capture precedes canvas target dispatch, including on iPad WebKit.
		this.page.addEventListener('pointerdown', this.handleInputPointerDown, true);
		this.page.addEventListener('pointermove', this.handleInputPointerContinuation, true);
		this.page.addEventListener('pointerup', this.handleInputPointerContinuation, true);
		this.page.addEventListener('pointercancel', this.handleInputPointerContinuation, true);
		this.page.addEventListener('lostpointercapture', this.handleInputPointerContinuation, true);
		this.ensureLiveInputCanvas();
		this.makeLiveInputDormant();
		this.disablePdfInteractionLayers();

		this.mutationObserver = new MutationObserver((records) => {
			if (this.disposed) return;
			if (this.diagnostics.isEnabled()) {
				let addedNodes = 0;
				let removedNodes = 0;
				for (const record of records) {
					addedNodes += record.addedNodes.length;
					removedNodes += record.removedNodes.length;
				}
				this.diagnostics.record('pdf.page-mutation', {
					key: this.keyValue,
					records: records.length,
					addedNodes,
					removedNodes,
					active: this.active,
				});
			}
			this.disablePdfInteractionLayers();
			const liveMissing = !this.liveInputAttached();
			const activePersistentMissing =
				this.active &&
				(this.persistent === null ||
					!this.persistent.isConnected ||
					!this.page.contains(this.persistent));
			if (liveMissing || activePersistentMissing) {
				this.releaseDetachedCanvases();
				// PDF.js may clear 51+ offscreen children in a single zoom.
				// Restore only visible/active input; page capture still works
				// even with no offscreen canvas at all.
				if (this.active || this.nearViewport) this.scheduleRecovery();
				else this.cancelRecovery();
			}
		});
		// PDF.js replaces direct page layers during zoom. Watching the entire
		// subtree made Jot react to thousands of irrelevant descendant changes.
		this.mutationObserver.observe(this.page, { childList: true });

		this.resizeObserver = new ResizeObserver(() => {
			// PDF.js resizes every page on each pinch frame. Only active Jot pages
			// need sizing work or verbose diagnostics; keep offscreen callbacks inert.
			if (!this.active) return;
			if (this.diagnostics.isEnabled()) {
				const rect = this.page.getBoundingClientRect();
				this.diagnostics.record('pdf.page-resize-observed', {
					key: this.keyValue,
					cssWidth: rect.width,
					cssHeight: rect.height,
					active: this.active,
				});
			}
			this.scheduleResize();
		});
		this.resizeObserver.observe(this.page);

		const win = this.page.ownerDocument.defaultView;
		const IntersectionObserverCtor = win?.IntersectionObserver;
		if (IntersectionObserverCtor && this.options.observerRoot) {
			this.intersectionObserver = new IntersectionObserverCtor(
				(entries) => {
					for (const entry of entries) {
						if (entry.target !== this.page) continue;
						if (entry.isIntersecting || entry.intersectionRatio > 0) {
							this.nearViewport = true;
							this.cancelDeactivate();
							this.activate('viewport');
						} else {
							this.nearViewport = false;
							this.scheduleDeactivate();
						}
					}
				},
				{
					root: this.options.observerRoot,
					rootMargin: this.options.rootMargin ?? '75% 0px 75% 0px',
					threshold: 0,
				},
			);
			this.intersectionObserver.observe(this.page);
		} else {
			// Compatibility fallback for older/limited environments.
			this.nearViewport = true;
			this.activate('fallback');
		}
	}

	refreshKey(key: string): void {
		if (this.keyValue === key) return;
		const previousKey = this.keyValue;
		this.keyValue = key;
		this.diagnostics.record('pdf.page-key-change', {
			previousKey,
			key,
		});
		this.replaceCanvases();
		if (this.active) this.resizeAndRedraw();
	}

	redraw(): void {
		const target = this.persistent;
		if (!target) return;
		const ctx = target.getContext('2d');
		if (!ctx) return;
		const surface = readCanvasSurface(target);
		ctx.setTransform(surface.dpr, 0, 0, surface.dpr, 0, 0);
		ctx.clearRect(0, 0, surface.width, surface.height);
		for (const stroke of this.strokes.forKey(this.keyValue)) {
			drawStroke(ctx, stroke, surface);
		}
	}

	appendStroke(stroke: Parameters<typeof drawStroke>[1]): void {
		if (!this.persistent) return;
		const ctx = this.persistent.getContext('2d');
		if (!ctx) return;
		drawStroke(ctx, stroke, readCanvasSurface(this.persistent));
	}

	clearLive(): void {
		if (!this.live) return;
		const ctx = this.live.getContext('2d');
		if (!ctx) return;
		const surface = readCanvasSurface(this.live);
		ctx.setTransform(surface.dpr, 0, 0, surface.dpr, 0, 0);
		ctx.clearRect(0, 0, surface.width, surface.height);
	}

	contains(canvas: HTMLCanvasElement): boolean {
		return canvas === this.persistent || canvas === this.live;
	}

	persistentCanvas(): HTMLCanvasElement | null {
		return this.persistent;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.diagnostics.record('pdf.page-binding-dispose', {
			key: this.keyValue,
			active: this.active,
			persistentWidth: this.persistent?.width ?? null,
			persistentHeight: this.persistent?.height ?? null,
			liveWidth: this.live?.width ?? null,
			liveHeight: this.live?.height ?? null,
		});
		this.mutationObserver?.disconnect();
		this.resizeObserver?.disconnect();
		this.intersectionObserver?.disconnect();
		this.mutationObserver = null;
		this.resizeObserver = null;
		this.intersectionObserver = null;
		this.cancelResize();
		this.cancelRecovery();
		this.cancelDeactivate();
		this.releaseAllCanvases();
		this.active = false;
		this.nearViewport = false;
		this.activePointerId = null;
		this.page.removeEventListener('pointerdown', this.handleInputPointerDown, true);
		this.page.removeEventListener('pointermove', this.handleInputPointerContinuation, true);
		this.page.removeEventListener('pointerup', this.handleInputPointerContinuation, true);
		this.page.removeEventListener('pointercancel', this.handleInputPointerContinuation, true);
		this.page.removeEventListener('lostpointercapture', this.handleInputPointerContinuation, true);
		this.page.classList.remove(PDF_PAGE_ANCHOR_CLASS);
		this.page.querySelector<HTMLElement>('.textLayer')?.classList.remove(PDF_PASSTHROUGH_CLASS);
		this.page.querySelector<HTMLElement>('.annotationLayer')?.classList.remove(PDF_PASSTHROUGH_CLASS);
	}

	private ensureCanvases(): void {
		if (this.disposed || !this.active) return;
		this.ensureLiveInputCanvas();

		const persistent = this.page.querySelector<HTMLCanvasElement>(`canvas.${PDF_OVERLAY_CLASS}`);
		if (this.persistent && this.persistent !== persistent) {
			this.releaseCanvas(this.persistent);
			this.persistent = null;
		}
		if (!persistent || persistent.getAttribute(INK_KEY_ATTR) !== this.keyValue) {
			const replaced = persistent !== null;
			if (persistent) this.releaseCanvas(persistent);
			this.persistent = this.createCanvas(PDF_OVERLAY_CLASS);
			this.page.appendChild(this.persistent);
			this.diagnostics.record('pdf.overlay-canvas-created', {
				key: this.keyValue,
				layer: 'persistent',
				replaced,
			});
		} else {
			this.persistent = persistent;
		}
	}

	private ensureLiveInputCanvas(): void {
		if (this.disposed) return;
		const live = this.page.querySelector<HTMLCanvasElement>(`canvas.${PDF_LIVE_OVERLAY_CLASS}`);
		if (this.live && this.live !== live) {
			this.detachLiveInput(this.live);
			this.releaseCanvas(this.live);
			this.live = null;
		}
		if (!live || live.getAttribute(INK_KEY_ATTR) !== this.keyValue) {
			const replaced = live !== null;
			if (live) this.releaseCanvas(live);
			this.live = this.createCanvas(PDF_LIVE_OVERLAY_CLASS);
			this.page.appendChild(this.live);
			this.attachLiveInput(this.live);
			this.diagnostics.record('pdf.overlay-canvas-created', {
				key: this.keyValue,
				layer: 'live-input',
				replaced,
			});
			return;
		}
		if (this.live !== live) {
			this.live = live;
			this.attachLiveInput(live);
			this.diagnostics.record('pdf.live-canvas-rewired', { key: this.keyValue });
		}
	}

	private attachLiveInput(canvas: HTMLCanvasElement): void {
		canvas.addEventListener('pointerup', this.handleInputPointerEnd, true);
		canvas.addEventListener('pointercancel', this.handleInputPointerEnd, true);
		canvas.addEventListener('lostpointercapture', this.handleInputPointerEnd, true);
		// Native contexts and drawing handlers are allocated only on activation.
	}

	private ensureLiveHandler(): void {
		if (!this.live || this.liveDisposer) return;
		const disposer = this.wireLiveCanvas(this.live, (forwarder) => {
			this.pointerForwarder = forwarder;
		});
		if (disposer === null) {
			// WebKit can transiently refuse a 2D context under memory pressure.
			// Never mark a failed handler as connected with a no-op disposer.
			this.pointerForwarder = null;
			if (this.contextRetryCount < 5 && this.page.ownerDocument.defaultView) {
				const delayMs = Math.min(8000, 500 * (2 ** this.contextRetryCount));
				this.contextRetryCount += 1;
				this.scheduleRecovery(delayMs);
			}
			return;
		}
		this.contextRetryCount = 0;
		this.liveDisposer = disposer ?? (() => {});
	}

	private detachLiveInput(canvas: HTMLCanvasElement): void {
		// PDF.js can remove the hit target mid-stroke without dispatching pointerup.
		this.activePointerId = null;
		if (!this.nearViewport) this.scheduleDeactivate();
		canvas.removeEventListener('pointerup', this.handleInputPointerEnd, true);
		canvas.removeEventListener('pointercancel', this.handleInputPointerEnd, true);
		canvas.removeEventListener('lostpointercapture', this.handleInputPointerEnd, true);
		this.liveDisposer?.();
		this.liveDisposer = null;
		this.pointerForwarder = null;
	}

	private replaceCanvases(): void {
		this.releaseAllCanvases();
		this.ensureLiveInputCanvas();
		if (this.active) {
			this.ensureCanvases();
			this.ensureLiveHandler();
		} else {
			this.makeLiveInputDormant();
		}
	}

	private createCanvas(className: string): HTMLCanvasElement {
		const canvas = this.page.ownerDocument.createElement('canvas');
		canvas.className = className;
		canvas.setAttribute(INK_KEY_ATTR, this.keyValue);
		return canvas;
	}

	private activate(reason: 'viewport' | 'input' | 'fallback'): void {
		if (this.disposed) return;
		this.cancelDeactivate();
		if (!this.active) {
			this.active = true;
			this.diagnostics.record('pdf.page-activate', { key: this.keyValue, reason });
		}
		this.ensureCanvases();
		this.ensureLiveHandler();
		this.disablePdfInteractionLayers();
		this.resizeAndRedraw();
	}

	private scheduleDeactivate(): void {
		if (this.disposed || !this.active || this.nearViewport || this.activePointerId !== null) return;
		const win = this.page.ownerDocument.defaultView;
		if (!win) {
			this.deactivateNow();
			return;
		}
		if (this.deactivationTimer !== null) win.clearTimeout(this.deactivationTimer);
		const delay = this.options.deactivationGraceMs ?? PDF_OVERLAY_DEACTIVATION_GRACE_MS;
		this.diagnostics.record('pdf.page-deactivate-scheduled', {
			key: this.keyValue,
			delayMs: delay,
		});
		this.deactivationTimer = win.setTimeout(() => {
			this.deactivationTimer = null;
			if (this.disposed || this.nearViewport || this.activePointerId !== null) return;
			this.deactivateNow();
		}, delay);
	}

	private cancelDeactivate(): void {
		if (this.deactivationTimer === null) return;
		this.page.ownerDocument.defaultView?.clearTimeout(this.deactivationTimer);
		this.deactivationTimer = null;
	}

	private deactivateNow(): void {
		if (!this.active) return;
		this.active = false;
		this.diagnostics.record('pdf.page-deactivate', { key: this.keyValue });
		this.cancelResize();
		this.cancelRecovery();
		if (this.persistent) {
			this.releaseCanvas(this.persistent);
			this.persistent = null;
		}
		this.liveDisposer?.();
		this.liveDisposer = null;
		this.pointerForwarder = null;
		this.makeLiveInputDormant();
	}

	private liveInputAttached(): boolean {
		return (
			this.live !== null &&
			this.live.isConnected &&
			this.page.contains(this.live)
		);
	}

	private trackedCanvasesAttached(): boolean {
		return (
			this.persistent !== null &&
			this.liveInputAttached() &&
			this.persistent.isConnected &&
			this.page.contains(this.persistent)
		);
	}

	private releaseDetachedCanvases(): void {
		if (
			this.persistent &&
			(!this.persistent.isConnected || !this.page.contains(this.persistent))
		) {
			this.releaseCanvas(this.persistent);
			this.persistent = null;
		}
		if (this.live && (!this.live.isConnected || !this.page.contains(this.live))) {
			this.detachLiveInput(this.live);
			this.releaseCanvas(this.live);
			this.live = null;
		}
	}

	private releaseAllCanvases(): void {
		if (this.persistent) this.releaseCanvas(this.persistent);
		if (this.live) {
			this.detachLiveInput(this.live);
			this.releaseCanvas(this.live);
		}
		this.persistent = null;
		this.live = null;
	}

	private makeLiveInputDormant(): void {
		const live = this.live;
		if (!live) return;
		if (this.diagnostics.isEnabled()) {
			this.diagnostics.record('pdf.live-input-dormant', {
				key: this.keyValue,
				width: live.width,
				height: live.height,
				area: live.width * live.height,
			});
		}
		live.width = 1;
		live.height = 1;
		// Inline pixel dimensions override the dormant 100% CSS rule after zoom.
		live.style.removeProperty('width');
		live.style.removeProperty('height');
		live.classList.add(PDF_DORMANT_INPUT_CLASS);
	}

	private releaseCanvas(canvas: HTMLCanvasElement): void {
		if (this.diagnostics.isEnabled()) {
			this.diagnostics.record('pdf.overlay-canvas-released', {
				key: this.keyValue,
				layer: canvas.classList.contains(PDF_LIVE_OVERLAY_CLASS) ? 'live' : 'persistent',
				width: canvas.width,
				height: canvas.height,
				area: canvas.width * canvas.height,
				connected: canvas.isConnected,
			});
		}
		canvas.width = 1;
		canvas.height = 1;
		canvas.remove();
	}

	private scheduleRecovery(delayOverrideMs?: number): void {
		if (this.disposed) return;
		const win = this.page.ownerDocument.defaultView;
		if (!win) {
			this.ensureLiveInputCanvas();
			if (this.active) {
				this.ensureCanvases();
				this.ensureLiveHandler();
				this.resizeAndRedraw();
			} else {
				this.makeLiveInputDormant();
			}
			return;
		}
		if (this.recoveryTimer !== null) win.clearTimeout(this.recoveryTimer);
		const delay = delayOverrideMs ?? this.options.recoveryDelayMs ?? PDF_OVERLAY_RECOVERY_DELAY_MS;
		this.diagnostics.record('pdf.overlay-recovery-scheduled', {
			key: this.keyValue,
			delayMs: delay,
			active: this.active,
		});
		this.recoveryTimer = win.setTimeout(() => {
			this.recoveryTimer = null;
			if (this.disposed || !this.page.isConnected) return;
			this.diagnostics.record('pdf.overlay-recovery-fired', {
				key: this.keyValue,
				active: this.active,
			});
			this.ensureLiveInputCanvas();
			if (this.active) {
				this.ensureCanvases();
				this.ensureLiveHandler();
				this.resizeAndRedraw();
			} else {
				this.makeLiveInputDormant();
			}
			this.disablePdfInteractionLayers();
		}, delay);
	}

	private cancelRecovery(): void {
		if (this.recoveryTimer === null) return;
		this.page.ownerDocument.defaultView?.clearTimeout(this.recoveryTimer);
		this.recoveryTimer = null;
	}

	private scheduleResize(): void {
		if (this.disposed || !this.active || this.resizeFrame !== null) return;
		const win = this.page.ownerDocument.defaultView;
		this.diagnostics.record('pdf.page-resize-scheduled', { key: this.keyValue });
		if (!win) {
			this.resizeAndRedraw();
			return;
		}
		this.resizeFrame = win.requestAnimationFrame(() => {
			this.resizeFrame = null;
			this.resizeAndRedraw();
		});
	}

	private cancelResize(): void {
		const win = this.page.ownerDocument.defaultView;
		if (this.resizeFrame !== null && win) win.cancelAnimationFrame(this.resizeFrame);
		this.resizeFrame = null;
	}

	private resizeAndRedraw(): void {
		if (this.disposed || !this.active) return;
		if (!this.trackedCanvasesAttached()) {
			this.releaseDetachedCanvases();
			this.scheduleRecovery();
			return;
		}
		const persistentChanged = this.persistent ? this.sizeCanvas(this.persistent) : false;
		const liveChanged = this.live ? this.sizeCanvas(this.live) : false;
		if (this.diagnostics.isEnabled()) {
			const rect = this.page.getBoundingClientRect();
			const nativeCanvas = Array.from(
				this.page.querySelectorAll<HTMLCanvasElement>('canvas'),
			).find(
				(canvas) =>
					!canvas.classList.contains(PDF_OVERLAY_CLASS) &&
					!canvas.classList.contains(PDF_LIVE_OVERLAY_CLASS),
			);
			this.diagnostics.record('pdf.page-resize-applied', {
				key: this.keyValue,
				cssWidth: rect.width,
				cssHeight: rect.height,
				nativeCanvasWidth: nativeCanvas?.width ?? null,
				nativeCanvasHeight: nativeCanvas?.height ?? null,
				nativeCanvasArea: nativeCanvas ? nativeCanvas.width * nativeCanvas.height : null,
				persistentWidth: this.persistent?.width ?? null,
				persistentHeight: this.persistent?.height ?? null,
				persistentArea: this.persistent
					? this.persistent.width * this.persistent.height
					: null,
				liveWidth: this.live?.width ?? null,
				liveHeight: this.live?.height ?? null,
				liveArea: this.live ? this.live.width * this.live.height : null,
				persistentChanged,
				liveChanged,
			});
		}
		if (persistentChanged) this.redraw();
		if (liveChanged) this.clearLive();
	}

	private sizeCanvas(canvas: HTMLCanvasElement): boolean {
		canvas.classList.remove(PDF_DORMANT_INPUT_CLASS);
		const rect = this.page.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return false;
		const win = this.page.ownerDocument.defaultView;
		const requestedDpr = devicePixelRatioFor(win ?? { devicePixelRatio: 1 });
		const effectiveDpr = safeBackingStoreDpr(
			rect.width,
			rect.height,
			requestedDpr,
			this.options.backingStoreLimits ?? PDF_OVERLAY_BACKING_STORE_LIMITS,
		);
		const changed = applyBackingStoreSize(canvas, rect.width, rect.height, effectiveDpr);
		const width = `${rect.width}px`;
		const height = `${rect.height}px`;
		if (canvas.style.width !== width) canvas.style.width = width;
		if (canvas.style.height !== height) canvas.style.height = height;
		return changed;
	}

	private disablePdfInteractionLayers(): void {
		this.page.querySelector<HTMLElement>('.textLayer')?.classList.add(PDF_PASSTHROUGH_CLASS);
		this.page.querySelector<HTMLElement>('.annotationLayer')?.classList.add(PDF_PASSTHROUGH_CLASS);
	}
}
