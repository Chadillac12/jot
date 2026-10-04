import {
	applyBackingStoreSize,
	devicePixelRatioFor,
	readCanvasSurface,
	safeBackingStoreDpr,
} from './canvas-surface';
import { INK_KEY_ATTR } from './ink-surface';
import { pageKey } from './jot-file';
import { drawStroke } from './stroke-render';
import type { Stroke } from './stroke-math';
import type { StrokeStore } from './stroke-store';

export const PDF_OVERLAY_CLASS = 'jot-overlay';
export const PDF_LIVE_OVERLAY_CLASS = 'jot-live-overlay';
const PAGE_ANCHOR_CLASS = 'jot-page-anchor';
const PASSTHROUGH_CLASS = 'jot-passthrough';

export class PdfPageBinding {
	private persistent: HTMLCanvasElement | null = null;
	private live: HTMLCanvasElement | null = null;
	private liveDisposer: (() => void) | null = null;
	private mutationObserver: MutationObserver;
	private resizeObserver: ResizeObserver;
	private resizeFrame: number | null = null;
	private disposed = false;

	constructor(
		readonly page: HTMLElement,
		readonly filePath: string,
		private strokes: StrokeStore,
		private wireOverlay: (canvas: HTMLCanvasElement) => () => void,
	) {
		this.mutationObserver = new MutationObserver(() => this.onMutation());
		this.resizeObserver = new ResizeObserver(() => this.scheduleResize());
		this.ensureCanvases();
		this.mutationObserver.observe(page, { childList: true, subtree: true });
		this.resizeObserver.observe(page);
	}

	get key(): string | null {
		const pageNumberAttr = this.page.getAttribute('data-page-number');
		if (!pageNumberAttr || !/^\d+$/.test(pageNumberAttr)) return null;
		const pageNumber = Number(pageNumberAttr);
		return Number.isSafeInteger(pageNumber) && pageNumber > 0
			? pageKey(this.filePath, pageNumber)
			: null;
	}

	get persistentCanvas(): HTMLCanvasElement | null {
		return this.persistent;
	}

	get liveCanvas(): HTMLCanvasElement | null {
		return this.live;
	}

	redraw(): void {
		const target = this.persistent;
		const key = this.key;
		if (!target || !key) return;
		const ctx = target.getContext('2d');
		if (!ctx) return;
		const surface = readCanvasSurface(target);
		ctx.setTransform(surface.dpr, 0, 0, surface.dpr, 0, 0);
		ctx.clearRect(0, 0, surface.width, surface.height);
		for (const stroke of this.strokes.forKey(key)) drawStroke(ctx, stroke, surface);
	}

	appendStroke(stroke: Stroke): void {
		const target = this.persistent;
		if (!target) return;
		const ctx = target.getContext('2d');
		if (!ctx) return;
		drawStroke(ctx, stroke, readCanvasSurface(target));
	}

	clearLive(): void {
		const target = this.live;
		if (!target) return;
		const ctx = target.getContext('2d');
		if (!ctx) return;
		const surface = readCanvasSurface(target);
		ctx.setTransform(surface.dpr, 0, 0, surface.dpr, 0, 0);
		ctx.clearRect(0, 0, surface.width, surface.height);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.mutationObserver.disconnect();
		this.resizeObserver.disconnect();
		const win = this.page.ownerDocument.defaultView;
		if (this.resizeFrame !== null && win) win.cancelAnimationFrame(this.resizeFrame);
		this.resizeFrame = null;
		this.liveDisposer?.();
		this.liveDisposer = null;
		this.persistent?.remove();
		this.live?.remove();
		this.persistent = null;
		this.live = null;
		this.page.classList.remove(PAGE_ANCHOR_CLASS);
		this.page.querySelector<HTMLElement>('.textLayer')?.classList.remove(PASSTHROUGH_CLASS);
		this.page.querySelector<HTMLElement>('.annotationLayer')?.classList.remove(PASSTHROUGH_CLASS);
	}

	private onMutation(): void {
		if (this.disposed) return;
		this.disableTextLayerInteraction();
		if (
			!this.persistent?.isConnected ||
			!this.live?.isConnected ||
			!this.page.contains(this.persistent) ||
			!this.page.contains(this.live)
		) {
			this.ensureCanvases();
		}
	}

	private ensureCanvases(): void {
		if (this.disposed) return;
		const key = this.key;
		if (!key) return;
		this.page.classList.add(PAGE_ANCHOR_CLASS);

		let persistent = this.page.querySelector<HTMLCanvasElement>(`canvas.${PDF_OVERLAY_CLASS}`);
		if (persistent?.getAttribute(INK_KEY_ATTR) !== key) {
			persistent?.remove();
			persistent = null;
		}
		if (!persistent) {
			persistent = this.page.ownerDocument.createElement('canvas');
			persistent.className = PDF_OVERLAY_CLASS;
			persistent.setAttribute(INK_KEY_ATTR, key);
			this.page.appendChild(persistent);
		}
		this.persistent = persistent;

		let live = this.page.querySelector<HTMLCanvasElement>(`canvas.${PDF_LIVE_OVERLAY_CLASS}`);
		if (live?.getAttribute(INK_KEY_ATTR) !== key) {
			live?.remove();
			live = null;
		}
		if (live !== this.live) {
			this.liveDisposer?.();
			this.liveDisposer = null;
		}
		if (!live) {
			live = this.page.ownerDocument.createElement('canvas');
			live.className = PDF_LIVE_OVERLAY_CLASS;
			live.setAttribute(INK_KEY_ATTR, key);
			this.page.appendChild(live);
		}
		this.live = live;
		if (!this.liveDisposer) this.liveDisposer = this.wireOverlay(live);

		this.disableTextLayerInteraction();
		this.resizeNow();
	}

	private scheduleResize(): void {
		if (this.disposed || this.resizeFrame !== null) return;
		const win = this.page.ownerDocument.defaultView;
		if (!win) {
			this.resizeNow();
			return;
		}
		let completedSynchronously = false;
		let frame = 0;
		frame = win.requestAnimationFrame(() => {
			completedSynchronously = true;
			this.resizeFrame = null;
			this.resizeNow();
		});
		if (!completedSynchronously) this.resizeFrame = frame;
	}

	private resizeNow(): void {
		if (this.disposed) return;
		const rect = this.page.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;
		const win = this.page.ownerDocument.defaultView;
		const requestedDpr = devicePixelRatioFor(win ?? { devicePixelRatio: 1 });
		const effectiveDpr = safeBackingStoreDpr(rect.width, rect.height, requestedDpr);

		const persistentChanged = this.persistent
			? this.sizeCanvas(this.persistent, rect.width, rect.height, effectiveDpr)
			: false;
		const liveChanged = this.live
			? this.sizeCanvas(this.live, rect.width, rect.height, effectiveDpr)
			: false;
		if (persistentChanged) this.redraw();
		if (liveChanged) this.clearLive();
	}

	private sizeCanvas(
		canvas: HTMLCanvasElement,
		width: number,
		height: number,
		dpr: number,
	): boolean {
		const changed = applyBackingStoreSize(canvas, width, height, dpr);
		const widthPx = `${width}px`;
		const heightPx = `${height}px`;
		if (canvas.style.width !== widthPx) canvas.style.width = widthPx;
		if (canvas.style.height !== heightPx) canvas.style.height = heightPx;
		return changed;
	}

	private disableTextLayerInteraction(): void {
		this.page.querySelector<HTMLElement>('.textLayer')?.classList.add(PASSTHROUGH_CLASS);
		this.page.querySelector<HTMLElement>('.annotationLayer')?.classList.add(PASSTHROUGH_CLASS);
	}
}
