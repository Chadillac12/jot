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

export const OVERLAY_KEY_ATTR = 'data-jot-key';

interface PendingResizeBatch {
	timer: number;
	pages: Map<HTMLElement, string>;
}

interface PageObservers {
	mutation: MutationObserver;
	resize: ResizeObserver;
}

export class OverlayManager {
	private containerObservers = new Map<WorkspaceLeaf, MutationObserver>();
	private containerFilePaths = new Map<WorkspaceLeaf, string>();
	private pageFilePaths = new WeakMap<HTMLElement, string>();
	private pageObservers = new Map<HTMLElement, PageObservers>();
	private wiredOverlays = new WeakSet<HTMLCanvasElement>();
	private renderablePages = new WeakSet<HTMLElement>();
	private intersectionObservers = new Map<Document, IntersectionObserver>();
	private resizeBatches = new Map<Document, PendingResizeBatch>();
	private resizeFrames = new Map<Document, number>();
	private resizeQueues = new Map<Document, Map<HTMLElement, string>>();

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
		if (existingObserver) {
			existingObserver.disconnect();
			this.containerObservers.delete(leaf);
			this.containerFilePaths.delete(leaf);
		}

		this.upgradePages(container, filePath);
		const observer = new MutationObserver((records) => {
			this.cleanupRemovedPages(records);
			const currentPath = this.filePathForLeaf(leaf);
			if (!currentPath) return;
			this.upgradeAddedPages(records, currentPath);
		});
		observer.observe(container, { childList: true, subtree: true });
		this.containerObservers.set(leaf, observer);
		this.containerFilePaths.set(leaf, filePath);
	}

	pruneClosedObservers(): void {
		if (this.containerObservers.size === 0) return;
		const live = new Set<WorkspaceLeaf>();
		this.app.workspace.iterateAllLeaves((leaf) => live.add(leaf));
		for (const [leaf, observer] of this.containerObservers) {
			if (!live.has(leaf)) {
				this.cleanupPagesIn(leaf.view.containerEl);
				observer.disconnect();
				this.containerObservers.delete(leaf);
				this.containerFilePaths.delete(leaf);
			}
		}
	}

	disconnectAll(): void {
		this.containerObservers.forEach((observer) => observer.disconnect());
		this.containerObservers.clear();
		this.containerFilePaths.clear();
		this.pageObservers.forEach(({ mutation, resize }) => {
			mutation.disconnect();
			resize.disconnect();
		});
		this.pageObservers.clear();
		this.intersectionObservers.forEach((observer) => observer.disconnect());
		this.intersectionObservers.clear();
		this.resizeBatches.forEach((batch, doc) => {
			const win = doc.defaultView ?? window;
			win.clearTimeout(batch.timer);
		});
		this.resizeBatches.clear();
		this.resizeFrames.forEach((frame, doc) => {
			const win = doc.defaultView ?? window;
			win.cancelAnimationFrame(frame);
		});
		this.resizeFrames.clear();
		this.resizeQueues.clear();
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
		this.canvasesIn(leaf).forEach((canvas) => {
			if (this.isCanvasRenderable(canvas)) this.redrawPage(canvas);
		});
	}

	redrawOverlaysForPdf(pdfPath: string): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (this.filePathForLeaf(leaf) !== pdfPath) return;
			this.canvasesIn(leaf).forEach((canvas) => {
				if (this.isCanvasRenderable(canvas)) this.redrawPage(canvas);
			});
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

	prepareForInput(canvas: HTMLCanvasElement): void {
		const page = canvas.closest<HTMLElement>('.page');
		if (!page) return;
		this.renderablePages.add(page);
		this.ensureOverlayWired(canvas);
		const backingStoreChanged = this.sizeOverlayToPage(canvas, page);
		this.disableTextLayerInteraction(page);
		this.keepOverlayOnTop(page, canvas);
		if (backingStoreChanged) this.redrawPage(canvas);
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

	private upgradeAddedPages(records: MutationRecord[], filePath: string): void {
		records.forEach((record) => {
			record.addedNodes.forEach((node) => {
				if (node.nodeType !== 1) return;
				const element = node as HTMLElement;
				if (element.matches('.page')) this.ensureOverlayOnPage(element, filePath);
				element
					.querySelectorAll<HTMLElement>('.page')
					.forEach((page) => this.ensureOverlayOnPage(page, filePath));
			});
		});
	}

	private cleanupRemovedPages(records: MutationRecord[]): void {
		records.forEach((record) => {
			record.removedNodes.forEach((node) => {
				if (node.nodeType !== 1) return;
				const element = node as HTMLElement;
				if (element.matches('.page')) this.cleanupPage(element);
				element
					.querySelectorAll<HTMLElement>('.page')
					.forEach((page) => this.cleanupPage(page));
			});
		});
	}


	private ensureOverlayOnPage(page: HTMLElement, filePath: string): void {
		const pageNumberAttr = page.getAttribute('data-page-number');
		const pageNumber = pageNumberAttr ? parseInt(pageNumberAttr, 10) : NaN;
		if (Number.isNaN(pageNumber)) return;
		const key = pageKey(filePath, pageNumber);
		this.pageFilePaths.set(page, filePath);
		page.classList.add(PAGE_ANCHOR_CLASS);
		const renderNow = this.shouldRenderPage(page);

		const existing = page.querySelector<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`);
		if (existing) {
			if (existing.getAttribute(OVERLAY_KEY_ATTR) === key) {
				this.sizeOverlayCssToPage(existing, page);
				if (renderNow) {
					this.sizeOverlayToPage(existing, page);
				} else {
					this.releaseOverlayBackingStore(existing);
				}
				this.disableTextLayerInteraction(page);
				this.ensureOverlayWired(existing);
				this.ensurePageObservers(page);
				this.keepOverlayOnTop(page, existing);
				if (renderNow) this.redrawPage(existing);
				return;
			}
			existing.remove();
		}

		const overlay = page.ownerDocument.createElement('canvas');
		overlay.className = OVERLAY_CLASS;
		overlay.setAttribute(OVERLAY_KEY_ATTR, key);
		this.sizeOverlayCssToPage(overlay, page);
		if (renderNow) {
			this.sizeOverlayToPage(overlay, page);
		} else {
			this.releaseOverlayBackingStore(overlay);
		}
		page.appendChild(overlay);
		this.disableTextLayerInteraction(page);
		this.ensureOverlayWired(overlay);
		this.ensurePageObservers(page);
		if (renderNow) this.redrawPage(overlay);
	}

	private ensurePageObservers(page: HTMLElement): void {
		if (this.pageObservers.has(page)) return;
		page.setAttribute(PAGE_OBSERVED_ATTR, '1');

		const mutation = new MutationObserver(() => {
			const current = page.querySelector<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`);
			if (!current) {
				const filePath = this.pageFilePaths.get(page);
				if (filePath) this.ensureOverlayOnPage(page, filePath);
				return;
			}
			this.ensureOverlayWired(current);
			this.disableTextLayerInteraction(page);
			this.keepOverlayOnTop(page, current);
		});
		mutation.observe(page, { childList: true, subtree: true });

		const resize = new ResizeObserver(() => {
			const filePath = this.pageFilePaths.get(page);
			if (!filePath) return;
			const current = page.querySelector<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`);
			if (!current) {
				this.ensureOverlayOnPage(page, filePath);
				return;
			}

			// During a live pinch, only stretch the existing bitmap with CSS. Resizing
			// canvas.width/height reallocates and clears the backing store, so doing it
			// on every ResizeObserver tick causes visible flashes and heavy redraw work.
			const sizeChanged = this.sizeOverlayCssToPage(current, page);
			this.disableTextLayerInteraction(page);
			if (!this.shouldRenderPage(page)) {
				this.releaseOverlayBackingStore(current);
				return;
			}
			if (sizeChanged) this.scheduleSettledResize(page, filePath);
		});
		resize.observe(page);

		this.pageObservers.set(page, { mutation, resize });
		this.observePageVisibility(page);
	}

	private scheduleSettledResize(page: HTMLElement, filePath: string): void {
		const doc = page.ownerDocument;
		const win = doc.defaultView ?? window;
		const existing = this.resizeBatches.get(doc);
		const pages = existing?.pages ?? new Map<HTMLElement, string>();
		if (existing) win.clearTimeout(existing.timer);

		const activeQueue = this.resizeQueues.get(doc);
		if (activeQueue) {
			activeQueue.forEach((queuedPath, queuedPage) => pages.set(queuedPage, queuedPath));
			this.resizeQueues.delete(doc);
			const pendingFrame = this.resizeFrames.get(doc);
			if (pendingFrame !== undefined) {
				win.cancelAnimationFrame(pendingFrame);
				this.resizeFrames.delete(doc);
			}
		}

		pages.set(page, filePath);
		const timer = win.setTimeout(() => {
			const batch = this.resizeBatches.get(doc);
			if (!batch || batch.timer !== timer) return;
			this.resizeBatches.delete(doc);
			this.flushSettledResizeBatch(doc, batch.pages);
		}, ZOOM_SETTLE_MS);

		this.resizeBatches.set(doc, { timer, pages });
	}

	private flushSettledResizeBatch(doc: Document, pages: Map<HTMLElement, string>): void {
		const win = doc.defaultView ?? window;
		const queue = new Map(pages);
		this.resizeQueues.set(doc, queue);

		const processNext = () => {
			this.resizeFrames.delete(doc);
			const iterator = queue.entries().next();
			if (iterator.done) {
				this.resizeQueues.delete(doc);
				return;
			}

			const [page, filePath] = iterator.value;
			queue.delete(page);
			if (page.isConnected && this.shouldRenderPage(page)) {
				const current = page.querySelector<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`);
				if (!current) {
					this.ensureOverlayOnPage(page, filePath);
				} else {
					this.ensureOverlayWired(current);
					this.sizeOverlayToPage(current, page);
					this.disableTextLayerInteraction(page);
					this.keepOverlayOnTop(page, current);
					this.redrawPage(current);
				}
			}

			if (queue.size > 0) {
				const frame = win.requestAnimationFrame(processNext);
				this.resizeFrames.set(doc, frame);
			} else {
				this.resizeQueues.delete(doc);
			}
		};

		if (queue.size > 0) {
			const frame = win.requestAnimationFrame(processNext);
			this.resizeFrames.set(doc, frame);
		}
	}

	private ensureOverlayWired(overlay: HTMLCanvasElement): void {
		if (this.wiredOverlays.has(overlay)) return;
		this.wiredOverlays.add(overlay);
		this.wireOverlay(overlay);
	}

	private keepOverlayOnTop(page: HTMLElement, overlay: HTMLCanvasElement): void {
		if (page.lastElementChild === overlay) return;
		page.appendChild(overlay);
	}

	private observePageVisibility(page: HTMLElement): void {
		if (typeof IntersectionObserver === 'undefined') {
			this.renderablePages.add(page);
			return;
		}

		const doc = page.ownerDocument;
		let observer = this.intersectionObservers.get(doc);
		if (!observer) {
			observer = new IntersectionObserver(
				(entries) => {
					entries.forEach((entry) => {
						const target = entry.target as HTMLElement;
						const filePath = this.pageFilePaths.get(target);
						if (!filePath) return;
						const overlay = target.querySelector<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`);

						if (entry.isIntersecting) {
							this.renderablePages.add(target);
							if (!overlay) {
								this.ensureOverlayOnPage(target, filePath);
								return;
							}
							this.ensureOverlayWired(overlay);
							this.sizeOverlayCssToPage(overlay, target);
							this.disableTextLayerInteraction(target);
							this.keepOverlayOnTop(target, overlay);
							this.scheduleSettledResize(target, filePath);
							return;
						}

						this.renderablePages.delete(target);
						if (overlay) this.releaseOverlayBackingStore(overlay);
					});
				},
				{ root: null, rootMargin: '100% 0px 100% 0px' },
			);
			this.intersectionObservers.set(doc, observer);
		}
		observer.observe(page);
	}

	private shouldRenderPage(page: HTMLElement): boolean {
		return this.renderablePages.has(page) || this.isPageNearViewport(page);
	}

	private isPageNearViewport(page: HTMLElement): boolean {
		const win = page.ownerDocument.defaultView;
		if (!win || win.innerHeight <= 0) return true;
		const rect = page.getBoundingClientRect();
		const margin = Math.max(win.innerHeight, 800);
		return rect.bottom >= -margin && rect.top <= win.innerHeight + margin;
	}

	private isCanvasRenderable(canvas: HTMLCanvasElement): boolean {
		const page = canvas.closest<HTMLElement>('.page');
		return page ? this.shouldRenderPage(page) : true;
	}

	private cleanupPagesIn(container: HTMLElement): void {
		container
			.querySelectorAll<HTMLElement>('.page')
			.forEach((page) => this.cleanupPage(page));
	}

	private cleanupPage(page: HTMLElement): void {
		const observers = this.pageObservers.get(page);
		if (observers) {
			observers.mutation.disconnect();
			observers.resize.disconnect();
			this.pageObservers.delete(page);
		}
		this.intersectionObservers.get(page.ownerDocument)?.unobserve(page);
		this.renderablePages.delete(page);
		this.pageFilePaths.delete(page);

		const doc = page.ownerDocument;
		const batch = this.resizeBatches.get(doc);
		if (batch) {
			batch.pages.delete(page);
			if (batch.pages.size === 0) {
				const win = doc.defaultView ?? window;
				win.clearTimeout(batch.timer);
				this.resizeBatches.delete(doc);
			}
		}

		const queue = this.resizeQueues.get(doc);
		if (queue) {
			queue.delete(page);
			if (queue.size === 0) {
				const win = doc.defaultView ?? window;
				const frame = this.resizeFrames.get(doc);
				if (frame !== undefined) win.cancelAnimationFrame(frame);
				this.resizeFrames.delete(doc);
				this.resizeQueues.delete(doc);
			}
		}
	}

	private releaseOverlayBackingStore(overlay: HTMLCanvasElement): void {
		if (overlay.width !== 1) overlay.width = 1;
		if (overlay.height !== 1) overlay.height = 1;
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

	private sizeOverlayToPage(overlay: HTMLCanvasElement, page: HTMLElement): boolean {
		const rect = page.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return false;
		const host = page.ownerDocument.defaultView ?? window;
		const requestedDpr = devicePixelRatioFor(host);
		const effectiveDpr = safeBackingStoreDpr(rect.width, rect.height, requestedDpr);
		const changed = applyBackingStoreSize(overlay, rect.width, rect.height, effectiveDpr);
		overlay.setCssStyles({
			width: `${rect.width}px`,
			height: `${rect.height}px`,
		});
		return changed;
	}

	private disableTextLayerInteraction(page: HTMLElement): void {
		page.querySelector<HTMLElement>('.textLayer')?.classList.add(PASSTHROUGH_CLASS);
		page.querySelector<HTMLElement>('.annotationLayer')?.classList.add(PASSTHROUGH_CLASS);
	}
}
