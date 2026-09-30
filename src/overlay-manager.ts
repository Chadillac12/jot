import { App, TFile, WorkspaceLeaf } from 'obsidian';
import {
	applyBackingStoreSize,
	devicePixelRatioFor,
	readCanvasSurface,
} from './canvas-surface';
import { pageKey } from './jot-file';
import { drawStroke } from './stroke-render';
import type { Stroke } from './stroke-math';
import type { StrokeStore } from './stroke-store';

const OVERLAY_CLASS = 'jot-overlay';
const LIVE_OVERLAY_CLASS = 'jot-live-overlay';
const PAGE_ANCHOR_CLASS = 'jot-page-anchor';
const PASSTHROUGH_CLASS = 'jot-passthrough';
const PAGE_OBSERVED_ATTR = 'data-jot-observed';

export const OVERLAY_KEY_ATTR = 'data-jot-key';

export class OverlayManager {
	private containerObservers = new Map<WorkspaceLeaf, MutationObserver>();

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
		if (this.containerObservers.has(leaf)) return;
		const observer = new MutationObserver(() => {
			const currentPath = this.filePathForLeaf(leaf);
			if (!currentPath) return;
			this.upgradePages(container, currentPath);
		});
		observer.observe(container, { childList: true, subtree: true });
		this.containerObservers.set(leaf, observer);
	}

	pruneClosedObservers(): void {
		if (this.containerObservers.size === 0) return;
		const live = new Set<WorkspaceLeaf>();
		this.app.workspace.iterateAllLeaves((leaf) => live.add(leaf));
		for (const [leaf, observer] of this.containerObservers) {
			if (!live.has(leaf)) {
				observer.disconnect();
				this.containerObservers.delete(leaf);
			}
		}
	}

	disconnectAll(): void {
		this.containerObservers.forEach((observer) => observer.disconnect());
		this.containerObservers.clear();
	}

	/**
	 * Redraw only persisted strokes. Pointer handlers are wired to the separate
	 * live canvas, so passing either layer here resolves to the persistent layer.
	 */
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
		for (const stroke of this.strokes.forKey(key)) {
			drawStroke(ctx, stroke, surface);
		}
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
		if (!leaf) return null;
		const viewType = leaf.view.getViewType?.();
		if (viewType !== 'pdf') return null;
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
		return leaf.view.containerEl.querySelectorAll<HTMLCanvasElement>(
			`canvas.${OVERLAY_CLASS}`,
		);
	}

	private upgradePages(container: HTMLElement, filePath: string): void {
		container
			.querySelectorAll<HTMLElement>('.page')
			.forEach((page) => this.ensureOverlayOnPage(page, filePath));
	}

	private ensureOverlayOnPage(page: HTMLElement, filePath: string): void {
		const pageNumberAttr = page.getAttribute('data-page-number');
		const pageNumber = pageNumberAttr ? parseInt(pageNumberAttr, 10) : NaN;
		if (Number.isNaN(pageNumber)) return;
		const key = pageKey(filePath, pageNumber);
		page.classList.add(PAGE_ANCHOR_CLASS);

		let persistent = page.querySelector<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`);
		if (persistent && persistent.getAttribute(OVERLAY_KEY_ATTR) !== key) {
			persistent.remove();
			persistent = null;
		}
		if (!persistent) {
			persistent = activeDocument.createElement('canvas');
			persistent.className = OVERLAY_CLASS;
			persistent.setAttribute(OVERLAY_KEY_ATTR, key);
			page.appendChild(persistent);
		}

		let live = page.querySelector<HTMLCanvasElement>(`canvas.${LIVE_OVERLAY_CLASS}`);
		if (live && live.getAttribute(OVERLAY_KEY_ATTR) !== key) {
			live.remove();
			live = null;
		}
		if (!live) {
			live = activeDocument.createElement('canvas');
			live.className = LIVE_OVERLAY_CLASS;
			live.setAttribute(OVERLAY_KEY_ATTR, key);
			page.appendChild(live);
			this.wireOverlay(live);
		}

		this.sizeOverlayToPage(persistent, page);
		this.sizeOverlayToPage(live, page);
		this.disableTextLayerInteraction(page);
		this.redrawPage(persistent);

		if (page.getAttribute(PAGE_OBSERVED_ATTR) === '1') return;
		page.setAttribute(PAGE_OBSERVED_ATTR, '1');

		new MutationObserver(() => {
			this.disableTextLayerInteraction(page);
			const hasPersistent = page.querySelector(`canvas.${OVERLAY_CLASS}`);
			const hasLive = page.querySelector(`canvas.${LIVE_OVERLAY_CLASS}`);
			if (!hasPersistent || !hasLive) this.ensureOverlayOnPage(page, filePath);
		}).observe(page, { childList: true });

		new ResizeObserver(() => {
			const currentPersistent = page.querySelector<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`);
			const currentLive = page.querySelector<HTMLCanvasElement>(`canvas.${LIVE_OVERLAY_CLASS}`);
			if (currentPersistent) {
				this.sizeOverlayToPage(currentPersistent, page);
				this.redrawPage(currentPersistent);
			}
			if (currentLive) {
				this.sizeOverlayToPage(currentLive, page);
				this.clearLivePage(currentLive);
			}
		}).observe(page);
	}

	private persistentCanvasFor(canvas: HTMLCanvasElement): HTMLCanvasElement | null {
		if (canvas.classList.contains(OVERLAY_CLASS)) return canvas;
		return canvas.parentElement?.querySelector<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`) ?? null;
	}

	private liveCanvasFor(canvas: HTMLCanvasElement): HTMLCanvasElement | null {
		if (canvas.classList.contains(LIVE_OVERLAY_CLASS)) return canvas;
		return canvas.parentElement?.querySelector<HTMLCanvasElement>(`canvas.${LIVE_OVERLAY_CLASS}`) ?? null;
	}

	private sizeOverlayToPage(overlay: HTMLCanvasElement, page: HTMLElement): void {
		const rect = page.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;
		const dpr = devicePixelRatioFor(window);
		applyBackingStoreSize(overlay, rect.width, rect.height, dpr);
		overlay.setCssStyles({
			width: `${rect.width}px`,
			height: `${rect.height}px`,
		});
	}

	private disableTextLayerInteraction(page: HTMLElement): void {
		page.querySelector<HTMLElement>('.textLayer')?.classList.add(PASSTHROUGH_CLASS);
		page.querySelector<HTMLElement>('.annotationLayer')?.classList.add(PASSTHROUGH_CLASS);
	}
}
