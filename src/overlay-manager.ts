import { App, TFile, WorkspaceLeaf } from 'obsidian';
import {
	applyBackingStoreSize,
	devicePixelRatioFor,
	readCanvasSurface,
	safeBackingStoreDpr,
} from './canvas-surface';
import { pageKey } from './jot-file';
import { drawStroke } from './stroke-render';
import type { StrokeStore } from './stroke-store';

const OVERLAY_CLASS = 'jot-overlay';
const PAGE_ANCHOR_CLASS = 'jot-page-anchor';
const PASSTHROUGH_CLASS = 'jot-passthrough';
const PAGE_OBSERVED_ATTR = 'data-jot-observed';
const ZOOM_SETTLE_MS = 120;
const PAGE_PREFETCH_MARGIN_PX = 1600;
const DISCONNECTED_PAGE_PRUNE_MS = 300;

export const OVERLAY_KEY_ATTR = 'data-jot-key';

interface PendingResizeBatch {
	timer: number;
	pages: Map<HTMLElement, string>;
}

interface PageRegistration {
	leaf: WorkspaceLeaf;
	filePath: string;
	key: string;
	pageNumber: number;
}

interface ActivePageObservers {
	mutation: MutationObserver;
	resize: ResizeObserver;
}

export class OverlayManager {
	private containerObservers = new Map<WorkspaceLeaf, MutationObserver>();
	private containerFilePaths = new Map<WorkspaceLeaf, string>();
	private intersectionObservers = new Map<WorkspaceLeaf, IntersectionObserver>();
	private pageRegistrations = new Map<HTMLElement, PageRegistration>();
	private pagesByLeafKey = new Map<WorkspaceLeaf, Map<string, HTMLElement>>();
	private activePageObservers = new Map<HTMLElement, ActivePageObservers>();
	private pageFilePaths = new WeakMap<HTMLElement, string>();
	private resizeBatches = new Map<Document, PendingResizeBatch>();
	private disconnectedPruneTimers = new Map<WorkspaceLeaf, number>();

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

		const existingObserver = this.containerObservers.get(leaf);
		if (existingObserver && this.containerFilePaths.get(leaf) === filePath) return;
		if (existingObserver || this.intersectionObservers.has(leaf)) this.disposeLeaf(leaf);

		this.registerPages(container, filePath, leaf);
		const observer = new MutationObserver((records) => {
			const currentPath = this.filePathForLeaf(leaf);
			if (!currentPath) return;
			const hadRemovals = this.registerAddedPages(records, currentPath, leaf);
			if (hadRemovals) this.scheduleDisconnectedPagePrune(leaf);
		});
		observer.observe(container, { childList: true, subtree: true });
		this.containerObservers.set(leaf, observer);
		this.containerFilePaths.set(leaf, filePath);
	}

	pruneClosedObservers(): void {
		if (this.containerObservers.size === 0 && this.intersectionObservers.size === 0) return;
		const live = new Set<WorkspaceLeaf>();
		this.app.workspace.iterateAllLeaves((leaf) => live.add(leaf));
		const observedLeaves = new Set<WorkspaceLeaf>([
			...this.containerObservers.keys(),
			...this.intersectionObservers.keys(),
		]);
		observedLeaves.forEach((leaf) => {
			if (!live.has(leaf)) this.disposeLeaf(leaf);
		});
	}

	disconnectAll(): void {
		const observedLeaves = new Set<WorkspaceLeaf>([
			...this.containerObservers.keys(),
			...this.intersectionObservers.keys(),
		]);
		observedLeaves.forEach((leaf) => this.disposeLeaf(leaf));
		this.containerObservers.clear();
		this.containerFilePaths.clear();
		this.intersectionObservers.clear();
		this.pagesByLeafKey.clear();
		this.pageRegistrations.clear();
		this.activePageObservers.clear();
		this.disconnectedPruneTimers.clear();

		this.resizeBatches.forEach((batch, doc) => {
			const win = doc.defaultView ?? window;
			win.clearTimeout(batch.timer);
		});
		this.resizeBatches.clear();
	}

	redrawPage(canvas: HTMLCanvasElement): void {
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		const surface = readCanvasSurface(canvas);
		ctx.setTransform(surface.dpr, 0, 0, surface.dpr, 0, 0);
		ctx.clearRect(0, 0, surface.width, surface.height);
		const key = canvas.getAttribute(OVERLAY_KEY_ATTR);
		if (!key) return;
		for (const stroke of this.strokes.forKey(key)) {
			drawStroke(ctx, stroke, surface);
		}
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

	private registerPages(container: HTMLElement, filePath: string, leaf: WorkspaceLeaf): void {
		container
			.querySelectorAll<HTMLElement>('.page')
			.forEach((page) => this.registerPage(page, filePath, leaf));
	}

	private registerAddedPages(
		records: MutationRecord[],
		filePath: string,
		leaf: WorkspaceLeaf,
	): boolean {
		let hadRemovals = false;
		records.forEach((record) => {
			if (record.removedNodes.length > 0) hadRemovals = true;
			record.addedNodes.forEach((node) => {
				if (node.nodeType !== 1) return;
				const element = node as HTMLElement;
				if (element.matches('.page')) this.registerPage(element, filePath, leaf);
				element
					.querySelectorAll<HTMLElement>('.page')
					.forEach((page) => this.registerPage(page, filePath, leaf));
			});
		});
		return hadRemovals;
	}

	private registerPage(page: HTMLElement, filePath: string, leaf: WorkspaceLeaf): void {
		const pageNumberAttr = page.getAttribute('data-page-number');
		const pageNumber = pageNumberAttr ? parseInt(pageNumberAttr, 10) : NaN;
		if (Number.isNaN(pageNumber)) return;

		const key = pageKey(filePath, pageNumber);
		const existingRegistration = this.pageRegistrations.get(page);
		if (
			existingRegistration?.leaf === leaf &&
			existingRegistration.filePath === filePath &&
			existingRegistration.key === key
		) {
			return;
		}
		if (existingRegistration) this.unregisterPage(page);

		const pagesForLeaf = this.pagesByLeafKey.get(leaf) ?? new Map<string, HTMLElement>();
		const previousPage = pagesForLeaf.get(key);
		if (previousPage && previousPage !== page) this.unregisterPage(previousPage);

		this.pageFilePaths.set(page, filePath);
		this.pageRegistrations.set(page, { leaf, filePath, key, pageNumber });
		pagesForLeaf.set(key, page);
		this.pagesByLeafKey.set(leaf, pagesForLeaf);
		page.classList.add(PAGE_ANCHOR_CLASS);

		// A plugin reload can leave canvases from the previous instance in the DOM.
		// Remove them before lazy observation so only near-viewport pages are materialized.
		this.deactivatePage(page);

		const intersectionObserver = this.intersectionObserverFor(leaf, page.ownerDocument);
		if (!intersectionObserver) {
			// Old/unsupported WebViews fall back to the previous eager behavior.
			this.activatePage(page);
			return;
		}
		intersectionObserver.observe(page);
	}

	private unregisterPage(page: HTMLElement): void {
		const registration = this.pageRegistrations.get(page);
		if (!registration) return;

		this.intersectionObservers.get(registration.leaf)?.unobserve(page);
		this.deactivatePage(page);
		this.pageRegistrations.delete(page);
		this.pageFilePaths.delete(page);
		page.classList.remove(PAGE_ANCHOR_CLASS);

		const pagesForLeaf = this.pagesByLeafKey.get(registration.leaf);
		if (pagesForLeaf?.get(registration.key) === page) pagesForLeaf.delete(registration.key);
		if (pagesForLeaf?.size === 0) this.pagesByLeafKey.delete(registration.leaf);
	}

	private intersectionObserverFor(
		leaf: WorkspaceLeaf,
		doc: Document,
	): IntersectionObserver | null {
		const existing = this.intersectionObservers.get(leaf);
		if (existing) return existing;

		const ObserverCtor = doc.defaultView?.IntersectionObserver ?? window.IntersectionObserver;
		if (typeof ObserverCtor !== 'function') return null;

		const observer = new ObserverCtor(
			(entries) => {
				entries.forEach((entry) => {
					const page = entry.target as HTMLElement;
					if (!this.pageRegistrations.has(page)) return;
					if (entry.isIntersecting) {
						this.activatePage(page);
					} else {
						this.deactivatePage(page);
					}
				});
			},
			{
				root: null,
				rootMargin: `${PAGE_PREFETCH_MARGIN_PX}px 0px ${PAGE_PREFETCH_MARGIN_PX}px 0px`,
				threshold: 0,
			},
		);
		this.intersectionObservers.set(leaf, observer);
		return observer;
	}

	private activatePage(page: HTMLElement): void {
		const registration = this.pageRegistrations.get(page);
		if (!registration || !page.isConnected) return;

		const existing = page.querySelector<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`);
		if (
			existing &&
			existing.getAttribute(OVERLAY_KEY_ATTR) === registration.key &&
			this.activePageObservers.has(page)
		) {
			return;
		}

		if (existing) existing.remove();

		const overlay = page.ownerDocument.createElement('canvas');
		overlay.className = OVERLAY_CLASS;
		overlay.setAttribute(OVERLAY_KEY_ATTR, registration.key);
		this.sizeOverlayToPage(overlay, page);
		page.appendChild(overlay);
		this.disableTextLayerInteraction(page);
		this.wireOverlay(overlay);
		this.ensurePageObservers(page);
		this.redrawPage(overlay);
	}

	private deactivatePage(page: HTMLElement): void {
		const observers = this.activePageObservers.get(page);
		if (observers) {
			observers.mutation.disconnect();
			observers.resize.disconnect();
			this.activePageObservers.delete(page);
		}
		page.removeAttribute(PAGE_OBSERVED_ATTR);
		this.removePageFromResizeBatches(page);
		page.querySelector<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`)?.remove();
		this.enableTextLayerInteraction(page);
	}

	private ensurePageObservers(page: HTMLElement): void {
		if (this.activePageObservers.has(page)) return;
		page.setAttribute(PAGE_OBSERVED_ATTR, '1');

		const mutation = new MutationObserver(() => {
			if (!this.activePageObservers.has(page)) return;
			const current = page.querySelector<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`);
			if (!current) {
				this.activatePage(page);
				return;
			}
			this.disableTextLayerInteraction(page);
		});
		mutation.observe(page, { childList: true, subtree: true });

		const resize = new ResizeObserver(() => {
			if (!this.activePageObservers.has(page)) return;
			const filePath = this.pageFilePaths.get(page);
			if (!filePath) return;
			const current = page.querySelector<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`);
			if (!current) {
				this.activatePage(page);
				return;
			}

			// During a live pinch, only stretch the existing bitmap with CSS. Resizing
			// canvas.width/height reallocates and clears the backing store, so doing it
			// on every ResizeObserver tick causes visible flashes and heavy redraw work.
			const sizeChanged = this.sizeOverlayCssToPage(current, page);
			this.disableTextLayerInteraction(page);
			if (sizeChanged) this.scheduleSettledResize(page, filePath);
		});
		resize.observe(page);

		this.activePageObservers.set(page, { mutation, resize });
	}

	private scheduleSettledResize(page: HTMLElement, filePath: string): void {
		const doc = page.ownerDocument;
		const win = doc.defaultView ?? window;
		const existing = this.resizeBatches.get(doc);
		const pages = existing?.pages ?? new Map<HTMLElement, string>();
		if (existing) win.clearTimeout(existing.timer);
		pages.set(page, filePath);

		const timer = win.setTimeout(() => {
			const batch = this.resizeBatches.get(doc);
			if (!batch || batch.timer !== timer) return;
			this.resizeBatches.delete(doc);
			this.flushSettledResizeBatch(batch.pages);
		}, ZOOM_SETTLE_MS);

		this.resizeBatches.set(doc, { timer, pages });
	}

	private flushSettledResizeBatch(pages: Map<HTMLElement, string>): void {
		pages.forEach((_filePath, page) => {
			if (!page.isConnected || !this.activePageObservers.has(page)) return;
			const current = page.querySelector<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`);
			if (!current) {
				this.activatePage(page);
				return;
			}
			this.sizeOverlayToPage(current, page);
			this.disableTextLayerInteraction(page);
			this.redrawPage(current);
		});
	}

	private removePageFromResizeBatches(page: HTMLElement): void {
		this.resizeBatches.forEach((batch, doc) => {
			if (!batch.pages.delete(page) || batch.pages.size > 0) return;
			const win = doc.defaultView ?? window;
			win.clearTimeout(batch.timer);
			this.resizeBatches.delete(doc);
		});
	}

	private scheduleDisconnectedPagePrune(leaf: WorkspaceLeaf): void {
		const doc = leaf.view.containerEl.ownerDocument;
		const win = doc.defaultView ?? window;
		const existing = this.disconnectedPruneTimers.get(leaf);
		if (existing !== undefined) win.clearTimeout(existing);

		const timer = win.setTimeout(() => {
			if (this.disconnectedPruneTimers.get(leaf) !== timer) return;
			this.disconnectedPruneTimers.delete(leaf);
			for (const [page, registration] of this.pageRegistrations) {
				if (registration.leaf === leaf && !page.isConnected) this.unregisterPage(page);
			}
		}, DISCONNECTED_PAGE_PRUNE_MS);
		this.disconnectedPruneTimers.set(leaf, timer);
	}

	private disposeLeaf(leaf: WorkspaceLeaf): void {
		this.containerObservers.get(leaf)?.disconnect();
		this.containerObservers.delete(leaf);
		this.containerFilePaths.delete(leaf);

		this.intersectionObservers.get(leaf)?.disconnect();
		this.intersectionObservers.delete(leaf);

		const timer = this.disconnectedPruneTimers.get(leaf);
		if (timer !== undefined) {
			const doc = leaf.view.containerEl.ownerDocument;
			const win = doc.defaultView ?? window;
			win.clearTimeout(timer);
			this.disconnectedPruneTimers.delete(leaf);
		}

		for (const [page, registration] of [...this.pageRegistrations]) {
			if (registration.leaf === leaf) this.unregisterPage(page);
		}
		this.pagesByLeafKey.delete(leaf);
	}

	private sizeOverlayCssToPage(overlay: HTMLCanvasElement, page: HTMLElement): boolean {
		const rect = page.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return false;
		const width = `${rect.width}px`;
		const height = `${rect.height}px`;
		if (overlay.style.width === width && overlay.style.height === height) return false;
		overlay.setCssStyles({ width, height });
		return true;
	}

	private sizeOverlayToPage(overlay: HTMLCanvasElement, page: HTMLElement): void {
		const rect = page.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;
		const requestedDpr = devicePixelRatioFor(window);
		const effectiveDpr = safeBackingStoreDpr(rect.width, rect.height, requestedDpr);
		applyBackingStoreSize(overlay, rect.width, rect.height, effectiveDpr);
		overlay.setCssStyles({
			width: `${rect.width}px`,
			height: `${rect.height}px`,
		});
	}

	private disableTextLayerInteraction(page: HTMLElement): void {
		page.querySelector<HTMLElement>('.textLayer')?.classList.add(PASSTHROUGH_CLASS);
		page.querySelector<HTMLElement>('.annotationLayer')?.classList.add(PASSTHROUGH_CLASS);
	}

	private enableTextLayerInteraction(page: HTMLElement): void {
		page.querySelector<HTMLElement>('.textLayer')?.classList.remove(PASSTHROUGH_CLASS);
		page.querySelector<HTMLElement>('.annotationLayer')?.classList.remove(PASSTHROUGH_CLASS);
	}
}
