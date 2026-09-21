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

export const OVERLAY_KEY_ATTR = 'data-jot-key';

interface PendingResizeBatch {
	timer: number;
	pages: Map<HTMLElement, string>;
}

export class OverlayManager {
	private containerObservers = new Map<WorkspaceLeaf, MutationObserver>();
	private containerFilePaths = new Map<WorkspaceLeaf, string>();
	private pageFilePaths = new WeakMap<HTMLElement, string>();
	private resizeBatches = new Map<Document, PendingResizeBatch>();

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

		countZoomDiagnostic('attachCalls');
		const existingObserver = this.containerObservers.get(leaf);
		if (existingObserver && this.containerFilePaths.get(leaf) === filePath) {
			countZoomDiagnostic('attachDedup');
			return;
		}
		if (existingObserver) {
			existingObserver.disconnect();
			this.containerObservers.delete(leaf);
			this.containerFilePaths.delete(leaf);
		}

		this.upgradePages(container, filePath);
		if (isZoomDiagnosticsEnabled()) {
			recordZoomDiagnosticEvent(`PDF leaf attached path=${filePath}`);
		}
		const observer = new MutationObserver((records) => {
			countZoomDiagnostic('containerMutationCallbacks');
			countZoomDiagnostic('containerMutationRecords', records.length);
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
		const lines = [
			`activePdf=${this.filePathForLeaf(leaf) ?? 'unknown'}`,
			`pages=${pages.length}`,
			`overlays=${overlays.length}`,
			`textLayers=${textLayerCount}`,
			`annotationLayers=${annotationLayerCount}`,
			`overlayBackingPixels=${backingPixels}`,
			`estimatedRgbaBytes=${estimatedRgbaBytes}`,
			`estimatedRgbaMiB=${(estimatedRgbaBytes / 1024 / 1024).toFixed(1)}`,
		];

		pages.slice(0, 12).forEach((page) => {
			const pageNumber = page.getAttribute('data-page-number') ?? '?';
			const pageOverlays = page.querySelectorAll<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`);
			const textLayer = page.querySelector<HTMLElement>('.textLayer');
			const annotationLayer = page.querySelector<HTMLElement>('.annotationLayer');
			lines.push(
				[
					`page=${pageNumber}`,
					`node=${zoomDiagnosticId(page, 'page')}`,
					`connected=${page.isConnected ? 1 : 0}`,
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

		if (pages.length > 12) lines.push(`pagesOmitted=${pages.length - 12}`);
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

	private ensureOverlayOnPage(page: HTMLElement, filePath: string): void {
		const pageNumberAttr = page.getAttribute('data-page-number');
		const pageNumber = pageNumberAttr ? parseInt(pageNumberAttr, 10) : NaN;
		if (Number.isNaN(pageNumber)) return;
		const key = pageKey(filePath, pageNumber);
		this.pageFilePaths.set(page, filePath);
		page.classList.add(PAGE_ANCHOR_CLASS);

		const existing = page.querySelector<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`);
		if (existing) {
			if (existing.getAttribute(OVERLAY_KEY_ATTR) === key) {
				this.sizeOverlayToPage(existing, page);
				this.disableTextLayerInteraction(page);
				this.ensurePageObservers(page);
				this.redrawPage(existing);
				return;
			}
			existing.remove();
		}

		const overlay = activeDocument.createElement('canvas');
		overlay.className = OVERLAY_CLASS;
		overlay.setAttribute(OVERLAY_KEY_ATTR, key);
		this.sizeOverlayToPage(overlay, page);
		page.appendChild(overlay);
		countZoomDiagnostic('overlayCreates');
		if (isZoomDiagnosticsEnabled()) {
			recordZoomDiagnosticEvent(
				`overlay created page=${pageNumber} pageNode=${zoomDiagnosticId(page, 'page')} overlay=${zoomDiagnosticId(overlay, 'overlay')}`,
			);
		}
		this.disableTextLayerInteraction(page);
		this.wireOverlay(overlay);
		this.ensurePageObservers(page);
		this.redrawPage(overlay);
	}

	private ensurePageObservers(page: HTMLElement): void {
		if (page.getAttribute(PAGE_OBSERVED_ATTR) === '1') return;
		page.setAttribute(PAGE_OBSERVED_ATTR, '1');

		new MutationObserver((records) => {
			countZoomDiagnostic('pageMutationCallbacks');
			countZoomDiagnostic('pageMutationRecords', records.length);
			const current = page.querySelector<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`);
			if (!current) {
				const filePath = this.pageFilePaths.get(page);
				if (filePath) this.ensureOverlayOnPage(page, filePath);
				return;
			}
			this.disableTextLayerInteraction(page);
		}).observe(page, { childList: true, subtree: true });

		new ResizeObserver(() => {
			countZoomDiagnostic('resizeCallbacks');
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
			if (sizeChanged) this.scheduleSettledResize(page, filePath);
		}).observe(page);
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
		pages.forEach((filePath, page) => {
			if (!page.isConnected) return;
			const current = page.querySelector<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`);
			if (!current) {
				this.ensureOverlayOnPage(page, filePath);
				return;
			}
			this.sizeOverlayToPage(current, page);
			this.disableTextLayerInteraction(page);
			this.redrawPage(current);
		});
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
}
