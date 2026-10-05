import {
	applyBackingStoreSize,
	devicePixelRatioFor,
	readCanvasSurface,
	safeBackingStoreDpr,
} from './canvas-surface';
import { INK_KEY_ATTR } from './ink-surface';
import { drawStroke } from './stroke-render';
import type { StrokeStore } from './stroke-store';

export const PDF_OVERLAY_CLASS = 'jot-overlay';
export const PDF_LIVE_OVERLAY_CLASS = 'jot-live-overlay';
export const PDF_PAGE_ANCHOR_CLASS = 'jot-page-anchor';
export const PDF_PASSTHROUGH_CLASS = 'jot-passthrough';

export class PdfPageBinding {
	private persistent: HTMLCanvasElement | null = null;
	private live: HTMLCanvasElement | null = null;
	private liveDisposer: (() => void) | null = null;
	private mutationObserver: MutationObserver | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private resizeFrame: number | null = null;
	private disposed = false;

	constructor(
		private page: HTMLElement,
		private keyValue: string,
		private strokes: StrokeStore,
		private wireLiveCanvas: (canvas: HTMLCanvasElement) => (() => void) | void,
	) {}

	get key(): string {
		return this.keyValue;
	}

	mount(): void {
		if (this.disposed) return;
		this.page.classList.add(PDF_PAGE_ANCHOR_CLASS);
		this.ensureCanvases();
		this.disablePdfInteractionLayers();
		this.resizeAndRedraw();

		this.mutationObserver = new MutationObserver(() => {
			if (this.disposed) return;
			this.ensureCanvases();
			this.disablePdfInteractionLayers();
		});
		this.mutationObserver.observe(this.page, { childList: true, subtree: true });

		this.resizeObserver = new ResizeObserver(() => this.scheduleResize());
		this.resizeObserver.observe(this.page);
	}

	refreshKey(key: string): void {
		if (this.keyValue === key) return;
		this.keyValue = key;
		this.replaceCanvases();
		this.resizeAndRedraw();
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
		this.mutationObserver?.disconnect();
		this.resizeObserver?.disconnect();
		this.mutationObserver = null;
		this.resizeObserver = null;
		const win = this.page.ownerDocument.defaultView;
		if (this.resizeFrame !== null && win) win.cancelAnimationFrame(this.resizeFrame);
		this.resizeFrame = null;
		this.liveDisposer?.();
		this.liveDisposer = null;
		this.persistent?.remove();
		this.live?.remove();
		this.persistent = null;
		this.live = null;
		this.page.classList.remove(PDF_PAGE_ANCHOR_CLASS);
		this.page.querySelector<HTMLElement>('.textLayer')?.classList.remove(PDF_PASSTHROUGH_CLASS);
		this.page.querySelector<HTMLElement>('.annotationLayer')?.classList.remove(PDF_PASSTHROUGH_CLASS);
	}

	private ensureCanvases(): void {
		if (this.disposed) return;
		const persistent = this.page.querySelector<HTMLCanvasElement>(`canvas.${PDF_OVERLAY_CLASS}`);
		if (!persistent || persistent.getAttribute(INK_KEY_ATTR) !== this.keyValue) {
			persistent?.remove();
			this.persistent = this.createCanvas(PDF_OVERLAY_CLASS);
			this.page.appendChild(this.persistent);
		} else {
			this.persistent = persistent;
		}

		const live = this.page.querySelector<HTMLCanvasElement>(`canvas.${PDF_LIVE_OVERLAY_CLASS}`);
		if (!live || live.getAttribute(INK_KEY_ATTR) !== this.keyValue) {
			this.liveDisposer?.();
			this.liveDisposer = null;
			live?.remove();
			this.live = this.createCanvas(PDF_LIVE_OVERLAY_CLASS);
			this.page.appendChild(this.live);
			this.liveDisposer = this.wireLiveCanvas(this.live) ?? null;
		} else if (this.live !== live) {
			this.liveDisposer?.();
			this.live = live;
			this.liveDisposer = this.wireLiveCanvas(this.live) ?? null;
		}
	}

	private replaceCanvases(): void {
		this.liveDisposer?.();
		this.liveDisposer = null;
		this.persistent?.remove();
		this.live?.remove();
		this.persistent = null;
		this.live = null;
		this.ensureCanvases();
	}

	private createCanvas(className: string): HTMLCanvasElement {
		const canvas = this.page.ownerDocument.createElement('canvas');
		canvas.className = className;
		canvas.setAttribute(INK_KEY_ATTR, this.keyValue);
		return canvas;
	}

	private scheduleResize(): void {
		if (this.disposed || this.resizeFrame !== null) return;
		const win = this.page.ownerDocument.defaultView;
		if (!win) {
			this.resizeAndRedraw();
			return;
		}
		this.resizeFrame = win.requestAnimationFrame(() => {
			this.resizeFrame = null;
			this.resizeAndRedraw();
		});
	}

	private resizeAndRedraw(): void {
		this.ensureCanvases();
		const persistentChanged = this.persistent ? this.sizeCanvas(this.persistent) : false;
		const liveChanged = this.live ? this.sizeCanvas(this.live) : false;
		if (persistentChanged) this.redraw();
		if (liveChanged) this.clearLive();
	}

	private sizeCanvas(canvas: HTMLCanvasElement): boolean {
		const rect = this.page.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return false;
		const win = this.page.ownerDocument.defaultView;
		const requestedDpr = devicePixelRatioFor(win ?? { devicePixelRatio: 1 });
		const effectiveDpr = safeBackingStoreDpr(rect.width, rect.height, requestedDpr);
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
