import { App, TFile, WorkspaceLeaf } from 'obsidian';
import {
	applyBackingStoreSize,
	devicePixelRatioFor,
	readCanvasSurface,
	safeBackingStoreDpr,
} from './canvas-surface';
import { pageKey } from './jot-file';
import {
	countZoomDiagnostic,
	isZoomDiagnosticsEnabled,
	recordZoomDiagnosticEvent,
	zoomDiagnosticId,
} from './zoom-diagnostics';
import { drawStroke } from './stroke-render';
import type { StrokeStore } from './stroke-store';

const OVERLAY_CLASS = 'jot-overlay';
const PAGE_ANCHOR_CLASS = 'jot-page-anchor';
const PASSTHROUGH_CLASS = 'jot-passthrough';
const PAGE_OBSERVED_ATTR = 'data-jot-observed';
const ZOOM_SETTLE_MS = 120;
const LAZY_ROOT_MARGIN = '1200px 0px';
const LAZY_DEACTIVATE_GRACE_MS = 750;
const PINNED_DEACTIVATE_RETRY_MS = 250;

export const OVERLAY_KEY_ATTR = 'data-jot-key';

interface PendingResizeBatch {
	timer: number;
	pages: Map<HTMLElement, string>;
}

interface PageObservers {
	mutation: MutationObserver;
	resize: ResizeObserver;
}

export interface CapturedPointerRouter {
	handleCapturedPointerEvent(event: PointerEvent): void;
}

export class OverlayManager {
	private containerObservers = new Map<WorkspaceLeaf, MutationObserver>();
	private containerFilePaths = new Map<WorkspaceLeaf, string>();
	private intersectionObservers = new Map<WorkspaceLeaf, IntersectionObserver>();
	private pageFilePaths = new WeakMap<HTMLElement, string>();
	private pageObservers = new WeakMap<HTMLElement, PageObservers>();
	private ownedOverlays = new WeakSet<HTMLCanvasElement>();
	private pageOverlays = new WeakMap<HTMLElement, HTMLCanvasElement>();
	private resizeBatches = new Map<Document, PendingResizeBatch>();
	private deactivationTimers = new Map<HTMLElement, number>();
	private pinnedPages = new Map<HTMLElement, number>();
	private penCaptureHandlers = new Map<WorkspaceLeaf, (event: PointerEvent) => void>();
	private pointerRouters = new WeakMap<HTMLCanvasElement, CapturedPointerRouter>();
	private activePenRoutes = new Map<number, CapturedPointerRouter>();

	constructor(
		private app: App,
		private strokes: StrokeStore,
		private wireOverlay: (canvas: HTMLCanvasElement) => CapturedPointerRouter | void,
	) {}

	attachToActivePdf(): void {
		const leaf = this.getActivePdfLeaf();
		if (!leaf) return;
		const filePath = this.filePathForLeaf(leaf);
		if (!filePath) return;
		const container = leaf.view.containerEl;

		countZoomDiagnostic('attachCalls');
		const existingObserver = this.containerObservers.get(leaf);
		if (existingObserver && this.containerFilePaths.get(leaf) === filePath) {
			countZoomDiagnostic('attachDedup');
			return;
		}
		if (existingObserver) this.disconnectLeaf(leaf);

		const intersectionObserver = this.createIntersectionObserver(container);
		if (intersectionObserver) {
			this.intersectionObservers.set(leaf, intersectionObserver);
		}

		this.registerPages(container, filePath, leaf);
		if (isZoomDiagnosticsEnabled()) {
			recordZoomDiagnosticEvent(`PDF leaf attached path=${filePath}`);
		}

		const observer = new MutationObserver((records) => {
			countZoomDiagnostic('containerMutationCallbacks');
			countZoomDiagnostic('containerMutationRecords', records.length);
			const currentPath = this.filePathForLeaf(leaf);
			if (!currentPath) return;
			this.registerAddedPages(records, currentPath, leaf);
			this.unregisterDirectlyRemovedPages(records, leaf);
		});
		observer.observe(container, { childList: true, subtree: true });
		this.containerObservers.set(leaf, observer);
		this.containerFilePaths.set(leaf, filePath);
		this.installPenCaptureDiagnostics(leaf, container);
	}

	pruneClosedObservers(): void {
		if (this.containerObservers.size === 0) return;
		const live = new Set<WorkspaceLeaf>();
		this.app.workspace.iterateAllLeaves((leaf) => live.add(leaf));
		for (const leaf of this.containerObservers.keys()) {
			if (!live.has(leaf)) this.disconnectLeaf(leaf);
		}
	}

	disconnectAll(): void {
		const leaves = new Set<WorkspaceLeaf>([
			...this.containerObservers.keys(),
			...this.intersectionObservers.keys(),
			...this.penCaptureHandlers.keys(),
		]);
		leaves.forEach((leaf) => this.disconnectLeaf(leaf));
		this.resizeBatches.forEach((batch, doc) => {
			const win = doc.defaultView ?? window;
			win.clearTimeout(batch.timer);
		});
		this.resizeBatches.clear();
		this.clearAllDeactivationTimers();
		this.pinnedPages.clear();
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

	zoomDiagnosticsSnapshot(): string[] {
		const leaf = this.getActivePdfLeaf();
		if (!leaf) return ['activePdf=none'];

		const container = leaf.view.containerEl;
		const pages = Array.from(container.querySelectorAll<HTMLElement>('.page'));
		const overlays = Array.from(
			container.querySelectorAll<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`),
		);
		const backingPixels = overlays.reduce(
			(total, overlay) => total + overlay.width * overlay.height,
			0,
		);
		const estimatedRgbaBytes = backingPixels * 4;
		const textLayerCount = pages.filter((page) => page.querySelector('.textLayer')).length;
		const annotationLayerCount = pages.filter((page) =>
			page.querySelector('.annotationLayer'),
		).length;
		const activePages = pages.filter((page) =>
			page.querySelector(`canvas.${OVERLAY_CLASS}`),
		);
		const inactivePages = pages.filter(
			(page) => !page.querySelector(`canvas.${OVERLAY_CLASS}`),
		);
		const reportPages = [...activePages, ...inactivePages].slice(0, 12);
		const lines = [
			`activePdf=${this.filePathForLeaf(leaf) ?? 'unknown'}`,
			`pages=${pages.length}`,
			`overlays=${overlays.length}`,
			`activePages=${activePages.length}`,
			`inactivePages=${inactivePages.length}`,
			`textLayers=${textLayerCount}`,
			`annotationLayers=${annotationLayerCount}`,
			`overlayBackingPixels=${backingPixels}`,
			`estimatedRgbaBytes=${estimatedRgbaBytes}`,
			`estimatedRgbaMiB=${(estimatedRgbaBytes / 1024 / 1024).toFixed(1)}`,
			`pendingDeactivations=${this.deactivationTimers.size}`,
			`pinnedPages=${this.pinnedPages.size}`,
		];

		reportPages.forEach((page) => {
			const pageNumber = page.getAttribute('data-page-number') ?? '?';
			const pageOverlays = page.querySelectorAll<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`);
			const textLayer = page.querySelector<HTMLElement>('.textLayer');
			const annotationLayer = page.querySelector<HTMLElement>('.annotationLayer');
			lines.push(
				[
					`page=${pageNumber}`,
					`node=${zoomDiagnosticId(page, 'page')}`,
					`connected=${page.isConnected ? 1 : 0}`,
					`active=${pageOverlays.length > 0 ? 1 : 0}`,
					`observed=${page.getAttribute(PAGE_OBSERVED_ATTR) === '1' ? 1 : 0}`,
					`overlayCount=${pageOverlays.length}`,
					`textPass=${textLayer?.classList.contains(PASSTHROUGH_CLASS) ? 1 : 0}`,
					`annotationPass=${annotationLayer?.classList.contains(PASSTHROUGH_CLASS) ? 1 : 0}`,
				].join(' '),
			);

			const overlay = pageOverlays.item(0);
			if (!overlay) return;
			const rect = overlay.getBoundingClientRect();
			const win = overlay.ownerDocument.defaultView ?? window;
			const style = win.getComputedStyle(overlay);
			lines.push(
				[
					`overlay=${zoomDiagnosticId(overlay, 'overlay')}`,
					`key=${overlay.getAttribute(OVERLAY_KEY_ATTR) ?? 'none'}`,
					`connected=${overlay.isConnected ? 1 : 0}`,
					`css=${overlay.style.width}x${overlay.style.height}`,
					`rect=${Math.round(rect.width)}x${Math.round(rect.height)}`,
					`backing=${overlay.width}x${overlay.height}`,
					`pointerEvents=${style.pointerEvents}`,
					`zIndex=${style.zIndex}`,
				].join(' '),
			);
		});

		if (pages.length > reportPages.length) {
			lines.push(`pagesOmitted=${pages.length - reportPages.length}`);
		}
		return lines;
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

	private createIntersectionObserver(container: HTMLElement): IntersectionObserver | null {
		const win = container.ownerDocument.defaultView ?? window;
		const ObserverCtor = win.IntersectionObserver;
		if (typeof ObserverCtor !== 'function') return null;

		const root =
			container.querySelector<HTMLElement>('.pdf-viewer-container, .pdf-scroll-container') ??
			null;
		countZoomDiagnostic(root ? 'lazyObserverPdfRoot' : 'lazyObserverViewportRoot');

		return new ObserverCtor(
			(entries) => {
				entries.forEach((entry) => {
					const page = entry.target as HTMLElement;
					if (!page.matches('.page')) return;
					const filePath = this.pageFilePaths.get(page);
					if (!filePath) return;
					if (entry.isIntersecting || entry.intersectionRatio > 0) {
						this.activatePage(page, filePath);
					} else {
						this.schedulePageDeactivation(page);
					}
				});
			},
			{
				root,
				rootMargin: LAZY_ROOT_MARGIN,
				threshold: 0,
			},
		);
	}

	private schedulePageDeactivation(page: HTMLElement, delayMs = LAZY_DEACTIVATE_GRACE_MS): void {
		if (this.deactivationTimers.has(page)) return;
		const win = page.ownerDocument.defaultView ?? window;
		countZoomDiagnostic('lazyDeactivationScheduled');
		const timer = win.setTimeout(() => {
			if (this.deactivationTimers.get(page) !== timer) return;
			this.deactivationTimers.delete(page);

			if ((this.pinnedPages.get(page) ?? 0) > 0) {
				countZoomDiagnostic('lazyDeactivationDeferredForPointer');
				this.schedulePageDeactivation(page, PINNED_DEACTIVATE_RETRY_MS);
				return;
			}
			this.deactivatePage(page);
		}, delayMs);
		this.deactivationTimers.set(page, timer);
	}

	private cancelPageDeactivation(page: HTMLElement): void {
		const timer = this.deactivationTimers.get(page);
		if (timer === undefined) return;
		const win = page.ownerDocument.defaultView ?? window;
		win.clearTimeout(timer);
		this.deactivationTimers.delete(page);
		countZoomDiagnostic('lazyDeactivationCancelled');
	}

	private clearAllDeactivationTimers(): void {
		for (const [page, timer] of this.deactivationTimers) {
			const win = page.ownerDocument.defaultView ?? window;
			win.clearTimeout(timer);
		}
		this.deactivationTimers.clear();
	}

	pinOverlay(overlay: HTMLCanvasElement): void {
		const page = overlay.closest<HTMLElement>('.page');
		if (!page) return;
		this.cancelPageDeactivation(page);
		this.pinnedPages.set(page, (this.pinnedPages.get(page) ?? 0) + 1);
		countZoomDiagnostic('lazyPagePins');
	}

	unpinOverlay(overlay: HTMLCanvasElement): void {
		const page = overlay.closest<HTMLElement>('.page');
		if (!page) return;
		const next = Math.max(0, (this.pinnedPages.get(page) ?? 0) - 1);
		if (next === 0) this.pinnedPages.delete(page);
		else this.pinnedPages.set(page, next);
		countZoomDiagnostic('lazyPageUnpins');
	}

	private installPenCaptureDiagnostics(leaf: WorkspaceLeaf, container: HTMLElement): void {
		if (this.penCaptureHandlers.has(leaf)) return;
		const handler = (event: PointerEvent) => {
			if (event.pointerType !== 'pen') return;

			if (event.type !== 'pointerdown') {
				const route = this.activePenRoutes.get(event.pointerId);
				if (!route) return;
				route.handleCapturedPointerEvent(event);
				if (event.type === 'pointerup' || event.type === 'pointercancel') {
					this.activePenRoutes.delete(event.pointerId);
				}
				return;
			}

			countZoomDiagnostic('pdfPenPointerDowns');
			const target = event.target as Element | null;
			const page = target?.closest?.('.page') as HTMLElement | null;
			if (!page) {
				countZoomDiagnostic('penDownOutsidePdfPage');
				return;
			}
			const overlay = page.querySelector<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`);
			if (overlay) {
				countZoomDiagnostic('penSurfaceCaptureHits');
				const targetIsOverlay =
					target === overlay || target?.closest?.(`canvas.${OVERLAY_CLASS}`) === overlay;
				if (targetIsOverlay) countZoomDiagnostic('penOverlayTargetHits');
				else countZoomDiagnostic('penOverlayTargetMisses');

				const route = this.pointerRouters.get(overlay);
				if (route) {
					this.activePenRoutes.set(event.pointerId, route);
					route.handleCapturedPointerEvent(event);
					countZoomDiagnostic('penCaptureRoutesEstablished');
				} else {
					countZoomDiagnostic('penCaptureRouterMisses');
				}
				return;
			}

			countZoomDiagnostic('penSurfaceMisses');
			if (isZoomDiagnosticsEnabled()) {
				recordZoomDiagnosticEvent(
					[
						'pen surface miss',
						`page=${page.getAttribute('data-page-number') ?? '?'}`,
						`pendingDeactivate=${this.deactivationTimers.has(page) ? 1 : 0}`,
						`pinned=${(this.pinnedPages.get(page) ?? 0) > 0 ? 1 : 0}`,
					].join(' '),
				);
			}
		};

		for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const) {
			container.addEventListener(type, handler, true);
		}
		this.penCaptureHandlers.set(leaf, handler);
	}

	private removePenCaptureDiagnostics(leaf: WorkspaceLeaf): void {
		const handler = this.penCaptureHandlers.get(leaf);
		if (!handler) return;
		for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const) {
			leaf.view.containerEl.removeEventListener(type, handler, true);
		}
		this.penCaptureHandlers.delete(leaf);
		this.activePenRoutes.clear();
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
	): void {
		records.forEach((record) => {
			record.addedNodes.forEach((node) => {
				if (node.nodeType !== 1) return;
				const element = node as HTMLElement;
				if (element.matches('.page')) {
					this.registerPage(element, filePath, leaf);
					return;
				}
				// PDF.js adds many text/annotation descendants inside an already-known
				// page. Those nodes cannot contain sibling PDF pages, so avoid a
				// recursive page search for every glyph/layer mutation.
				if (element.closest('.page')) return;
				element
					.querySelectorAll<HTMLElement>('.page')
					.forEach((page) => this.registerPage(page, filePath, leaf));
			});
		});
	}

	private unregisterDirectlyRemovedPages(records: MutationRecord[], leaf: WorkspaceLeaf): void {
		const intersectionObserver = this.intersectionObservers.get(leaf);
		records.forEach((record) => {
			record.removedNodes.forEach((node) => {
				if (node.nodeType !== 1) return;
				const element = node as HTMLElement;
				if (!element.matches('.page')) return;
				intersectionObserver?.unobserve(element);
				this.deactivatePage(element);
				this.pageFilePaths.delete(element);
			});
		});
	}

	private registerPage(page: HTMLElement, filePath: string, leaf: WorkspaceLeaf): void {
		this.pageFilePaths.set(page, filePath);
		const intersectionObserver = this.intersectionObservers.get(leaf);
		if (intersectionObserver) {
			intersectionObserver.observe(page);
			countZoomDiagnostic('lazyPagesObserved');
			return;
		}

		// Compatibility fallback for environments without IntersectionObserver.
		this.activatePage(page, filePath);
	}

	private activatePage(page: HTMLElement, filePath: string): void {
		this.cancelPageDeactivation(page);
		const pageNumberAttr = page.getAttribute('data-page-number');
		const pageNumber = pageNumberAttr ? parseInt(pageNumberAttr, 10) : NaN;
		if (Number.isNaN(pageNumber)) return;
		const key = pageKey(filePath, pageNumber);
		this.pageFilePaths.set(page, filePath);
		page.classList.add(PAGE_ANCHOR_CLASS);

		const existing = page.querySelector<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`);
		if (
			existing &&
			this.ownedOverlays.has(existing) &&
			existing.getAttribute(OVERLAY_KEY_ATTR) === key
		) {
			this.pageOverlays.set(page, existing);
			this.sizeOverlayToPage(existing, page);
			this.disableTextLayerInteraction(page);
			this.ensurePageObservers(page);
			this.redrawPage(existing);
			return;
		}
		if (existing) this.releaseOverlay(existing);

		const cached = this.pageOverlays.get(page);
		if (
			cached &&
			this.ownedOverlays.has(cached) &&
			cached.getAttribute(OVERLAY_KEY_ATTR) === key
		) {
			this.sizeOverlayToPage(cached, page);
			page.appendChild(cached);
			countZoomDiagnostic('overlayReattachments');
			if (isZoomDiagnosticsEnabled()) {
				recordZoomDiagnosticEvent(
					`overlay reattached page=${pageNumber} pageNode=${zoomDiagnosticId(page, 'page')} overlay=${zoomDiagnosticId(cached, 'overlay')}`,
				);
			}
			this.disableTextLayerInteraction(page);
			this.ensurePageObservers(page);
			this.redrawPage(cached);
			return;
		}

		const doc = page.ownerDocument;
		const overlay = doc.createElement('canvas');
		overlay.className = OVERLAY_CLASS;
		overlay.setAttribute(OVERLAY_KEY_ATTR, key);
		this.sizeOverlayToPage(overlay, page);
		page.appendChild(overlay);
		this.ownedOverlays.add(overlay);
		this.pageOverlays.set(page, overlay);
		countZoomDiagnostic('overlayCreates');
		countZoomDiagnostic('lazyPageActivations');
		if (isZoomDiagnosticsEnabled()) {
			recordZoomDiagnosticEvent(
				`page activated page=${pageNumber} pageNode=${zoomDiagnosticId(page, 'page')} overlay=${zoomDiagnosticId(overlay, 'overlay')}`,
			);
		}
		this.disableTextLayerInteraction(page);
		const pointerRouter = this.wireOverlay(overlay);
		if (pointerRouter) this.pointerRouters.set(overlay, pointerRouter);
		this.ensurePageObservers(page);
		this.redrawPage(overlay);
	}

	private deactivatePage(page: HTMLElement): void {
		this.cancelPageDeactivation(page);
		this.pinnedPages.delete(page);
		this.cancelPendingResize(page);
		this.disconnectPageObservers(page);

		const overlay =
			page.querySelector<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`) ??
			this.pageOverlays.get(page) ??
			null;
		if (overlay) {
			countZoomDiagnostic('lazyPageDeactivations');
			if (isZoomDiagnosticsEnabled()) {
				recordZoomDiagnosticEvent(
					`page deactivated page=${page.getAttribute('data-page-number') ?? '?'} pageNode=${zoomDiagnosticId(page, 'page')}`,
				);
			}
			this.releaseOverlay(overlay);
		}
		this.pageOverlays.delete(page);
		this.enableTextLayerInteraction(page);
		page.classList.remove(PAGE_ANCHOR_CLASS);
	}

	private releaseOverlay(overlay: HTMLCanvasElement): void {
		// Drop the backing store before removing the node so WebKit can reclaim
		// the large RGBA allocation immediately instead of waiting for GC.
		this.ownedOverlays.delete(overlay);
		this.pointerRouters.delete(overlay);
		overlay.width = 0;
		overlay.height = 0;
		overlay.remove();
	}

	private ensurePageObservers(page: HTMLElement): void {
		if (this.pageObservers.has(page)) return;

		const mutation = new MutationObserver((records) => {
			countZoomDiagnostic('pageMutationCallbacks');
			countZoomDiagnostic('pageMutationRecords', records.length);
			const current = page.querySelector<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`);
			if (!current) {
				const cached = this.pageOverlays.get(page);
				if (cached && this.ownedOverlays.has(cached) && !cached.isConnected) {
					countZoomDiagnostic('overlayExternalRemovals');
				}
				const filePath = this.pageFilePaths.get(page);
				if (filePath && page.isConnected) this.activatePage(page, filePath);
				return;
			}
			this.disableTextLayerInteraction(page);
		});
		mutation.observe(page, { childList: true, subtree: true });

		const resize = new ResizeObserver(() => {
			countZoomDiagnostic('resizeCallbacks');
			const filePath = this.pageFilePaths.get(page);
			if (!filePath) return;
			const current = page.querySelector<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`);
			if (!current) return;

			// During a live pinch, only stretch the existing bitmap with CSS.
			const sizeChanged = this.sizeOverlayCssToPage(current, page);
			this.disableTextLayerInteraction(page);
			if (sizeChanged) this.scheduleSettledResize(page, filePath);
		});
		resize.observe(page);

		this.pageObservers.set(page, { mutation, resize });
		page.setAttribute(PAGE_OBSERVED_ATTR, '1');
	}

	private disconnectPageObservers(page: HTMLElement): void {
		const observers = this.pageObservers.get(page);
		if (observers) {
			observers.mutation.disconnect();
			observers.resize.disconnect();
			this.pageObservers.delete(page);
		}
		page.removeAttribute(PAGE_OBSERVED_ATTR);
	}

	private disconnectLeaf(leaf: WorkspaceLeaf): void {
		this.removePenCaptureDiagnostics(leaf);
		this.containerObservers.get(leaf)?.disconnect();
		this.containerObservers.delete(leaf);
		this.containerFilePaths.delete(leaf);

		this.intersectionObservers.get(leaf)?.disconnect();
		this.intersectionObservers.delete(leaf);

		leaf.view.containerEl
			.querySelectorAll<HTMLElement>('.page')
			.forEach((page) => {
				this.deactivatePage(page);
				this.pageFilePaths.delete(page);
			});
	}

	private cancelPendingResize(page: HTMLElement): void {
		const doc = page.ownerDocument;
		const batch = this.resizeBatches.get(doc);
		if (!batch) return;
		batch.pages.delete(page);
		if (batch.pages.size > 0) return;
		const win = doc.defaultView ?? window;
		win.clearTimeout(batch.timer);
		this.resizeBatches.delete(doc);
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
		countZoomDiagnostic('settleBatches');
		countZoomDiagnostic('settledPages', pages.size);
		if (isZoomDiagnosticsEnabled()) {
			recordZoomDiagnosticEvent(`settle batch pages=${pages.size}`);
		}
		pages.forEach((_filePath, page) => {
			if (!page.isConnected) return;
			const current = page.querySelector<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`);
			if (!current) return;
			this.sizeOverlayToPage(current, page);
			this.disableTextLayerInteraction(page);
			this.redrawPage(current);
		});
	}

	private sizeOverlayCssToPage(overlay: HTMLCanvasElement, page: HTMLElement): boolean {
		const rect = page.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return false;

		// Keep the hit-test box bound to the page through pure CSS. This tracks
		// live pinch geometry synchronously instead of waiting for ResizeObserver.
		if (overlay.style.width !== '100%' || overlay.style.height !== '100%') {
			overlay.setCssStyles({ width: '100%', height: '100%' });
		}

		const requestedDpr = devicePixelRatioFor(page.ownerDocument.defaultView ?? window);
		const effectiveDpr = safeBackingStoreDpr(rect.width, rect.height, requestedDpr);
		const targetWidth = Math.max(1, Math.round(rect.width * effectiveDpr));
		const targetHeight = Math.max(1, Math.round(rect.height * effectiveDpr));
		return overlay.width !== targetWidth || overlay.height !== targetHeight;
	}

	private sizeOverlayToPage(overlay: HTMLCanvasElement, page: HTMLElement): void {
		const rect = page.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;
		const requestedDpr = devicePixelRatioFor(page.ownerDocument.defaultView ?? window);
		const effectiveDpr = safeBackingStoreDpr(rect.width, rect.height, requestedDpr);
		applyBackingStoreSize(overlay, rect.width, rect.height, effectiveDpr);
		overlay.setCssStyles({
			width: '100%',
			height: '100%',
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
