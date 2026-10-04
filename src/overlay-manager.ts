import { App, TFile, WorkspaceLeaf } from 'obsidian';
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

const OVERLAY_CLASS = 'jot-overlay';
const LIVE_OVERLAY_CLASS = 'jot-live-overlay';
const PAGE_ANCHOR_CLASS = 'jot-page-anchor';
const PASSTHROUGH_CLASS = 'jot-passthrough';

export const OVERLAY_KEY_ATTR = INK_KEY_ATTR;

interface LeafObserverBinding {
	container: HTMLElement;
	observer: MutationObserver;
}

class PdfPageBinding {
	readonly persistent: HTMLCanvasElement;
	readonly live: HTMLCanvasElement;

	private mutationObserver: MutationObserver;
	private resizeObserver: ResizeObserver;
	private resizeFrame: number | null = null;
	private disposed = false;

	constructor(
		readonly page: HTMLElement,
		readonly key: string,
		private onResize: (binding: PdfPageBinding) => void,
		private onInvalidated: (binding: PdfPageBinding) => void,
		wireOverlay: (canvas: HTMLCanvasElement) => void,
	) {
		const doc = page.ownerDocument;
		page.classList.add(PAGE_ANCHOR_CLASS);

		// Remove stale canvases from a previous plugin instance before wiring new
		// handlers. Ownership is per binding, never inferred from leftover DOM.
		page.querySelectorAll(`canvas.${OVERLAY_CLASS}, canvas.${LIVE_OVERLAY_CLASS}`).forEach(
			(canvas) => canvas.remove(),
		);

		this.persistent = doc.createElement('canvas');
		this.persistent.className = OVERLAY_CLASS;
		this.persistent.setAttribute(OVERLAY_KEY_ATTR, key);
		page.appendChild(this.persistent);

		this.live = doc.createElement('canvas');
		this.live.className = LIVE_OVERLAY_CLASS;
		this.live.setAttribute(OVERLAY_KEY_ATTR, key);
		page.appendChild(this.live);
		wireOverlay(this.live);

		this.mutationObserver = new MutationObserver(() => {
			if (this.disposed) return;
			if (!this.page.isConnected || !this.persistent.isConnected || !this.live.isConnected) {
				this.onInvalidated(this);
			}
		});
		this.mutationObserver.observe(page, { childList: true, subtree: true });

		this.resizeObserver = new ResizeObserver(() => this.scheduleResize());
		this.resizeObserver.observe(page);
		this.scheduleResize();
	}

	scheduleResize(): void {
		if (this.disposed || this.resizeFrame !== null) return;
		const win = this.page.ownerDocument.defaultView;
		if (!win) {
			this.onResize(this);
			return;
		}
		this.resizeFrame = win.requestAnimationFrame(() => {
			this.resizeFrame = null;
			if (!this.disposed) this.onResize(this);
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.mutationObserver.disconnect();
		this.resizeObserver.disconnect();
		const win = this.page.ownerDocument.defaultView;
		if (win && this.resizeFrame !== null) win.cancelAnimationFrame(this.resizeFrame);
		this.resizeFrame = null;
		this.persistent.remove();
		this.live.remove();
		this.page.classList.remove(PAGE_ANCHOR_CLASS);
		this.page.querySelector<HTMLElement>('.textLayer')?.classList.remove(PASSTHROUGH_CLASS);
		this.page.querySelector<HTMLElement>('.annotationLayer')?.classList.remove(PASSTHROUGH_CLASS);
	}
}

export class OverlayManager {
	private leafObservers = new Map<WorkspaceLeaf, LeafObserverBinding>();
	private pageBindings = new Map<HTMLElement, PdfPageBinding>();

	constructor(
		private app: App,
		private strokes: StrokeStore,
		private wireOverlay: (canvas: HTMLCanvasElement) => void,
	) {}

	attachToActivePdf(): void {
		const leaf = this.getActivePdfLeaf();
		if (!leaf) return;
		const filePath = this.filePathForLeaf(leaf);
		if (!filePath) return;
		const container = leaf.view.containerEl;

		this.upgradePages(container, filePath);
		if (this.leafObservers.has(leaf)) return;

		const observer = new MutationObserver(() => {
			const currentPath = this.filePathForLeaf(leaf);
			if (!currentPath) return;
			this.upgradePages(container, currentPath);
		});
		observer.observe(container, { childList: true, subtree: true });
		this.leafObservers.set(leaf, { container, observer });
	}

	pruneClosedObservers(): void {
		const liveLeaves = new Set<WorkspaceLeaf>();
		this.app.workspace.iterateAllLeaves((leaf) => liveLeaves.add(leaf));
		for (const [leaf, binding] of this.leafObservers) {
			if (liveLeaves.has(leaf)) continue;
			binding.observer.disconnect();
			this.leafObservers.delete(leaf);
		}
		this.pruneDetachedPageBindings();
	}

	disconnectAll(): void {
		for (const binding of this.leafObservers.values()) binding.observer.disconnect();
		this.leafObservers.clear();
		for (const binding of this.pageBindings.values()) binding.dispose();
		this.pageBindings.clear();
	}

	redrawPage(canvas: HTMLCanvasElement): void {
		const target = this.persistentCanvasFor(canvas);
		if (!target) return;
		const ctx = target.getContext('2d');
		if (!ctx) return;
		const surface = readCanvasSurface(target);
		ctx.setTransform(surface.dpr, 0, 0, surface.dpr, 0, 0);
		ctx.clearRect(0, 0, surface.width, surface.height);
		const key = target.getAttribute(OVERLAY_KEY_ATTR);
		if (!key) return;
		for (const stroke of this.strokes.forKey(key)) drawStroke(ctx, stroke, surface);
	}

	appendPersistedStroke(canvas: HTMLCanvasElement, stroke: Stroke): void {
		const target = this.persistentCanvasFor(canvas);
		if (!target) return;
		const ctx = target.getContext('2d');
		if (!ctx) return;
		drawStroke(ctx, stroke, readCanvasSurface(target));
	}

	clearLivePage(canvas: HTMLCanvasElement): void {
		const target = this.liveCanvasFor(canvas);
		if (!target) return;
		const ctx = target.getContext('2d');
		if (!ctx) return;
		const surface = readCanvasSurface(target);
		ctx.setTransform(surface.dpr, 0, 0, surface.dpr, 0, 0);
		ctx.clearRect(0, 0, surface.width, surface.height);
	}

	redrawOverlaysForActivePdf(): void {
		const leaf = this.getActivePdfLeaf();
		if (!leaf) return;
		this.canvasesIn(leaf).forEach((canvas) => this.redrawPage(canvas));
	}

	redrawOverlaysForPdf(pdfPath: string): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (this.filePathForLeaf(leaf) !== pdfPath) return;
			this.canvasesIn(leaf).forEach((canvas) => this.redrawPage(canvas));
		});
	}

	overlayForKey(key: string): HTMLCanvasElement | null {
		const leaf = this.getActivePdfLeaf();
		if (!leaf) return null;
		const escaped = key.replace(/["\\]/g, '\\$&');
		return leaf.view.containerEl.querySelector<HTMLCanvasElement>(
			`canvas.${OVERLAY_CLASS}[${OVERLAY_KEY_ATTR}="${escaped}"]`,
		);
	}

	getActivePdfLeaf(): WorkspaceLeaf | null {
		const leaf = this.app.workspace.getMostRecentLeaf();
		if (!leaf || leaf.view.getViewType?.() !== 'pdf') return null;
		return leaf;
	}

	getActivePdfFilePath(): string | null {
		const leaf = this.getActivePdfLeaf();
		return leaf ? this.filePathForLeaf(leaf) : null;
	}

	private filePathForLeaf(leaf: WorkspaceLeaf): string | null {
		const file = (leaf.view as { file?: TFile }).file;
		return file?.path ?? null;
	}

	private canvasesIn(leaf: WorkspaceLeaf): NodeListOf<HTMLCanvasElement> {
		return leaf.view.containerEl.querySelectorAll<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`);
	}

	private upgradePages(container: HTMLElement, filePath: string): void {
		const currentPages = new Set(
			Array.from(container.querySelectorAll<HTMLElement>('.page')),
		);
		for (const page of currentPages) this.ensureBinding(page, filePath);

		for (const [page, binding] of this.pageBindings) {
			if (!page.isConnected || (container.contains(page) && !currentPages.has(page))) {
				binding.dispose();
				this.pageBindings.delete(page);
			}
		}
	}

	private ensureBinding(page: HTMLElement, filePath: string): void {
		const pageNumberAttr = page.getAttribute('data-page-number');
		const pageNumber = pageNumberAttr && /^\d+$/.test(pageNumberAttr) ? Number(pageNumberAttr) : NaN;
		if (!Number.isFinite(pageNumber) || pageNumber <= 0) return;
		const key = pageKey(filePath, pageNumber);

		const existing = this.pageBindings.get(page);
		if (existing?.key === key) {
			this.disableTextLayerInteraction(page);
			existing.scheduleResize();
			return;
		}
		if (existing) {
			existing.dispose();
			this.pageBindings.delete(page);
		}

		const binding = new PdfPageBinding(
			page,
			key,
			(current) => this.resizeBinding(current),
			(current) => this.recreateBinding(current, filePath),
			this.wireOverlay,
		);
		this.pageBindings.set(page, binding);
		this.disableTextLayerInteraction(page);
		this.resizeBinding(binding);
	}

	private recreateBinding(binding: PdfPageBinding, filePath: string): void {
		const page = binding.page;
		binding.dispose();
		this.pageBindings.delete(page);
		if (page.isConnected) this.ensureBinding(page, filePath);
	}

	private resizeBinding(binding: PdfPageBinding): void {
		if (!binding.page.isConnected) return;
		const persistentChanged = this.sizeOverlayToPage(binding.persistent, binding.page);
		const liveChanged = this.sizeOverlayToPage(binding.live, binding.page);
		this.disableTextLayerInteraction(binding.page);
		if (persistentChanged) this.redrawPage(binding.persistent);
		if (liveChanged) this.clearLivePage(binding.live);
	}

	private pruneDetachedPageBindings(): void {
		for (const [page, binding] of this.pageBindings) {
			if (page.isConnected) continue;
			binding.dispose();
			this.pageBindings.delete(page);
		}
	}

	private persistentCanvasFor(canvas: HTMLCanvasElement): HTMLCanvasElement | null {
		if (canvas.classList.contains(OVERLAY_CLASS)) return canvas;
		return canvas.parentElement?.querySelector<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`) ?? null;
	}

	private liveCanvasFor(canvas: HTMLCanvasElement): HTMLCanvasElement | null {
		if (canvas.classList.contains(LIVE_OVERLAY_CLASS)) return canvas;
		return canvas.parentElement?.querySelector<HTMLCanvasElement>(`canvas.${LIVE_OVERLAY_CLASS}`) ?? null;
	}

	private sizeOverlayToPage(overlay: HTMLCanvasElement, page: HTMLElement): boolean {
		const rect = page.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return false;
		const win = page.ownerDocument.defaultView;
		const requestedDpr = devicePixelRatioFor(win ?? { devicePixelRatio: 1 });
		const effectiveDpr = safeBackingStoreDpr(rect.width, rect.height, requestedDpr);
		const backingChanged = applyBackingStoreSize(overlay, rect.width, rect.height, effectiveDpr);
		const width = `${rect.width}px`;
		const height = `${rect.height}px`;
		const cssChanged = overlay.style.width !== width || overlay.style.height !== height;
		if (cssChanged) {
			overlay.style.width = width;
			overlay.style.height = height;
		}
		return backingChanged || cssChanged;
	}

	private disableTextLayerInteraction(page: HTMLElement): void {
		page.querySelector<HTMLElement>('.textLayer')?.classList.add(PASSTHROUGH_CLASS);
		page.querySelector<HTMLElement>('.annotationLayer')?.classList.add(PASSTHROUGH_CLASS);
	}
}
