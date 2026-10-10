import {
	applyBackingStoreSize,
	type CanvasBackingStoreLimits,
	devicePixelRatioFor,
	readCanvasSurface,
	safeBackingStoreDpr,
} from './canvas-surface';
import { INK_KEY_ATTR, type InkSurfaceController } from './ink-surface';
import type { PdfLiveWiring, PdfPointerForwarder } from './pdf-page-binding';
import {
	NULL_DIAGNOSTICS,
	type DiagnosticSink,
} from './persistent-diagnostics';
import { documentPageKey } from './jot-file';
import type { JotNoteFile, JotNotePage } from './jot-note-file';
import { drawStroke } from './stroke-render';
import type { Stroke } from './stroke-math';
import type { StrokeStore } from './stroke-store';

const PAGE_CLASS = 'jot-note-page';
const SHEET_CLASS = 'jot-note-sheet';
const PAPER_CLASS = 'jot-note-paper';
const PERSISTENT_CLASS = 'jot-note-ink';
const LIVE_CLASS = 'jot-note-live-ink';
const CANVAS_ERROR_CLASS = 'jot-note-canvas-error';
const LIVE_DORMANT_CLASS = 'jot-note-live-dormant';
const DEACTIVATION_GRACE_MS = 750;

export interface JotNoteSurfaceOptions {
	observerRoot?: Element;
	eagerMountFirstPage?: boolean;
	rootMargin?: string;
	backingStoreLimits?: CanvasBackingStoreLimits;
	fixedLogicalBackingStore?: boolean;
	deactivationGraceMs?: number;
	diagnostics?: DiagnosticSink;
}

interface NotebookPageMount {
	sheet: HTMLElement;
	key: string;
	sourceWidth: number;
	sourceHeight: number;
	persistent: HTMLCanvasElement | null;
	live: HTMLCanvasElement | null;
	resizeObserver: ResizeObserver | null;
	resizeFrame: number | null;
	deactivationTimer: number | null;
	retryTimer: number | null;
	nearViewport: boolean;
	activePointerId: number | null;
	applyResize: (() => void) | null;
	contextRetryCount: number;
	onPointerDown: (event: PointerEvent) => void;
	onPointerEnd: (event: PointerEvent) => void;
	onPointerContinuation: (event: PointerEvent) => void;
	inputForwarder: PdfPointerForwarder | null;
	pointerListenersAttached: boolean;
	painted: boolean;
	disposeInput: (() => void) | null;
	inputWired: boolean;
	errorEl: HTMLElement | null;
}

export class JotNoteSurface implements InkSurfaceController {
	private intersectionObserver: IntersectionObserver | null = null;
	private pageMounts = new Map<HTMLElement, NotebookPageMount>();

	constructor(
		private host: HTMLElement,
		private strokes: StrokeStore,
		private wireOverlay: PdfLiveWiring,
		private options: JotNoteSurfaceOptions = {},
	) {}

	render(note: JotNoteFile, documentPath: string): void {
		this.diagnostics().record('jot-surface.render', {
			documentPath,
			pages: note.pages.length,
			fixedLogicalBackingStore: this.options.fixedLogicalBackingStore ?? false,
		});
		this.disconnect();
		this.host.replaceChildren();
		this.intersectionObserver = this.createIntersectionObserver();

		note.pages.forEach((page, index) => {
			this.renderPage(note, page, documentPath, index);
		});
	}

	setPaperStyle(style: JotNoteFile['paper']): void {
		const classes = [
			'jot-note-paper-blank',
			'jot-note-paper-ruled',
			'jot-note-paper-grid',
			'jot-note-paper-dot',
		];
		for (const paper of Array.from(
			this.host.querySelectorAll<HTMLElement>(`.${PAPER_CLASS}`),
		)) {
			paper.classList.remove(...classes);
			paper.classList.add(`jot-note-paper-${style}`);
		}
	}

	redrawAll(): void {
		this.host
			.querySelectorAll<HTMLCanvasElement>(`canvas.${PERSISTENT_CLASS}`)
			.forEach((canvas) => this.redrawPage(canvas));
	}

	redrawKey(key: string): void {
		const canvas = this.overlayForKey(key);
		if (canvas) this.redrawPage(canvas);
	}

	disconnect(): void {
		this.intersectionObserver?.disconnect();
		this.intersectionObserver = null;
		for (const sheet of [...this.pageMounts.keys()]) this.unmountPage(sheet, true);
		this.pageMounts.clear();
	}

	redrawPage(canvas: HTMLCanvasElement): void {
		const target = this.persistentCanvasFor(canvas);
		if (!target) return;
		const ctx = target.getContext('2d');
		if (!ctx) return;
		const surface = readCanvasSurface(target);
		ctx.setTransform(surface.dpr, 0, 0, surface.dpr, 0, 0);
		ctx.clearRect(0, 0, surface.width, surface.height);
		const key = target.getAttribute(INK_KEY_ATTR);
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

	overlayForKey(key: string): HTMLCanvasElement | null {
		const escaped = key.replace(/["\\]/g, '\\$&');
		return this.host.querySelector<HTMLCanvasElement>(
			`canvas.${PERSISTENT_CLASS}[${INK_KEY_ATTR}="${escaped}"]`,
		);
	}

	private createIntersectionObserver(): IntersectionObserver | null {
		const win = this.host.ownerDocument.defaultView;
		const Observer = win?.IntersectionObserver;
		if (!Observer) return null;
		return new Observer(
			(entries) => {
				for (const entry of entries) {
					const sheet = entry.target as HTMLElement;
					if (entry.isIntersecting || entry.intersectionRatio > 0) {
						this.diagnostics().record('jot-surface.intersection-mount', {
							key: this.pageMounts.get(sheet)?.key ?? null,
							ratio: entry.intersectionRatio,
						});
						const mount = this.pageMounts.get(sheet);
						if (mount) {
							mount.nearViewport = true;
							this.cancelDeactivation(mount);
						}
						this.mountPage(sheet);
					} else {
						this.diagnostics().record('jot-surface.intersection-unmount', {
							key: this.pageMounts.get(sheet)?.key ?? null,
							ratio: entry.intersectionRatio,
						});
						const mount = this.pageMounts.get(sheet);
						if (mount) {
							mount.nearViewport = false;
							this.scheduleDeactivation(mount);
						}
					}
				}
			},
			{
				root: this.options.observerRoot ?? this.host.parentElement,
				rootMargin: this.options.rootMargin ?? '100% 0px 100% 0px',
				threshold: 0,
			},
		);
	}

	private renderPage(
		note: JotNoteFile,
		page: JotNotePage,
		documentPath: string,
		index: number,
	): void {
		const doc = this.host.ownerDocument;
		const wrapper = doc.createElement('section');
		wrapper.className = PAGE_CLASS;

		const label = doc.createElement('div');
		label.className = 'jot-note-page-label';
		label.textContent = `Page ${index + 1}`;
		wrapper.appendChild(label);

		const sheet = doc.createElement('div');
		sheet.className = SHEET_CLASS;
		// Do not rely on CSS aspect-ratio for notebook page height. On iPad
		// WKWebView a zero-height sheet removes the paper, live ink canvas and
		// Pencil gesture target together. A percentage-padding pseudo element
		// gives the sheet deterministic geometry from its width instead.
		sheet.style.setProperty(
			'--jot-page-height-ratio',
			`${(page.height / page.width) * 100}%`,
		);
		wrapper.appendChild(sheet);

		const paperSpacing = 64;
		const paper = doc.createElement('div');
		paper.className = `${PAPER_CLASS} jot-note-paper-${note.paper}`;
		paper.style.setProperty('--jot-paper-x', `${(paperSpacing / page.width) * 100}%`);
		paper.style.setProperty('--jot-paper-y', `${(paperSpacing / page.height) * 100}%`);
		sheet.appendChild(paper);

		const mount: NotebookPageMount = {
			sheet,
			key: documentPageKey(documentPath, page.id),
			sourceWidth: page.width,
			sourceHeight: page.height,
			persistent: null,
			live: null,
			resizeObserver: null,
			resizeFrame: null,
			deactivationTimer: null,
			retryTimer: null,
			nearViewport: false,
			activePointerId: null,
			applyResize: null,
			contextRetryCount: 0,
			onPointerDown: (event) => {
				if (event.pointerType !== 'pen' && event.pointerType !== 'mouse') return;
				const originalTargetWasLive = event.target === mount.live;
				mount.contextRetryCount = 0;
				this.cancelDeactivation(mount);
				this.mountPage(sheet, true);
				// A stale-canvas replacement clears the old pointer; claim the
				// new contact only after that replacement has finished.
				mount.activePointerId = event.pointerId;
				if (!originalTargetWasLive) {
					if (mount.inputForwarder) {
						mount.inputForwarder(event);
						this.diagnostics().record('jot-surface.input-forwarded', { key: mount.key, phase: 'down' });
					} else {
						this.diagnostics().record('jot-surface.input-unavailable', { key: mount.key, reason: 'no-live-handler' });
						mount.activePointerId = null;
						if (!mount.nearViewport) this.scheduleDeactivation(mount);
					}
				}
			},
			onPointerEnd: (event) => {
				if (event.pointerType !== 'pen' && event.pointerType !== 'mouse') return;
				if (event.pointerId !== mount.activePointerId) return;
				mount.activePointerId = null;
				if (!mount.nearViewport) this.scheduleDeactivation(mount);
			},
			onPointerContinuation: (event) => {
				if (event.pointerId !== mount.activePointerId) return;
				if (event.target !== mount.live) mount.inputForwarder?.(event);
				if (event.type === 'pointerup' || event.type === 'pointercancel' ||
					event.type === 'lostpointercapture') mount.onPointerEnd(event);
			},
			inputForwarder: null,
			pointerListenersAttached: false,
			painted: false,
			disposeInput: null,
			inputWired: false,
			errorEl: null,
		};
		this.pageMounts.set(sheet, mount);
		this.host.appendChild(wrapper);
		this.ensureInputTarget(mount);

		if (this.intersectionObserver) {
			this.intersectionObserver.observe(sheet);
			if (index === 0 && (this.options.eagerMountFirstPage ?? true)) {
				this.mountPage(sheet);
			}
		} else {
			this.mountPage(sheet);
		}
	}

	private mountPage(sheet: HTMLElement, immediate = false): void {
		const mount = this.pageMounts.get(sheet);
		if (!mount) return;
		// The PDF viewer can remove the canvas while keeping the parent sheet.
		// Reactivate from the original page-level Pencil event.
		this.ensureInputTarget(mount);
		if (mount.persistent) {
			this.wireInputIfPossible(mount);
			if (immediate) {
				const win = sheet.ownerDocument.defaultView;
				if (mount.resizeFrame !== null) win?.cancelAnimationFrame(mount.resizeFrame);
				mount.resizeFrame = null;
				mount.applyResize?.();
			}
			return;
		}
		this.diagnostics().record('jot-surface.mount-page', {
			key: mount.key,
			sourceWidth: mount.sourceWidth,
			sourceHeight: mount.sourceHeight,
			fixedLogicalBackingStore: this.options.fixedLogicalBackingStore ?? false,
		});

		const doc = sheet.ownerDocument;
		const persistent = this.makeCanvas(doc, PERSISTENT_CLASS, mount.key);
		this.ensureInputTarget(mount);
		const live = mount.live;
		if (!live) return;
		sheet.insertBefore(persistent, live);
		mount.persistent = persistent;

		this.wireInputIfPossible(mount);
		const persistentCtx = persistent.getContext('2d');
		const liveCtx = live.getContext('2d');
		if (!persistentCtx || !liveCtx) {
			this.releaseCanvas(persistent);
			mount.persistent = null;
			this.showCanvasUnavailable(mount);
			this.scheduleContextRetry(mount);
			return;
		}
		mount.errorEl?.remove();
		mount.errorEl = null;

		live.classList.remove(LIVE_DORMANT_CLASS);

		const applyResize = () => {
			if (!mount.persistent || !mount.live) return;
			const persistentChanged = this.sizeCanvas(mount.persistent, sheet, mount);
			const liveChanged = this.sizeCanvas(mount.live, sheet, mount);
			if (!persistentChanged && !liveChanged && mount.painted) return;
			mount.painted = true;
			this.redrawPage(mount.persistent);
			this.clearLivePage(mount.live);
		};

		mount.applyResize = applyResize;
		const scheduleResize = () => {
			const win = doc.defaultView;
			if (!win) {
				applyResize();
				return;
			}
			if (mount.resizeFrame !== null) return;
			let completedSynchronously = false;
			let frame = 0;
			frame = win.requestAnimationFrame(() => {
				completedSynchronously = true;
				mount.resizeFrame = null;
				applyResize();
			});
			if (!completedSynchronously) mount.resizeFrame = frame;
		};

		if (!this.options.fixedLogicalBackingStore) {
			const ResizeObserverCtor = doc.defaultView?.ResizeObserver;
			if (ResizeObserverCtor) {
				mount.resizeObserver = new ResizeObserverCtor(scheduleResize);
				mount.resizeObserver.observe(sheet);
			}
		}
		if (immediate) applyResize();
		else scheduleResize();
	}

	private ensureInputTarget(mount: NotebookPageMount): void {
		if (!mount.pointerListenersAttached) {
			mount.sheet.addEventListener('pointerdown', mount.onPointerDown, true);
			for (const event of ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture'] as const) {
				mount.sheet.addEventListener(event, mount.onPointerContinuation, true);
			}
			mount.pointerListenersAttached = true;
		}
		if (mount.live && mount.live.isConnected && mount.sheet.contains(mount.live)) {
			return;
		}
		if (mount.live) {
			mount.disposeInput?.();
			mount.disposeInput = null;
			mount.inputWired = false;
			mount.inputForwarder = null;
			this.releaseCanvas(mount.live);
			mount.live = null;
			mount.activePointerId = null;
		}
		const canvas = this.makeCanvas(mount.sheet.ownerDocument, LIVE_CLASS, mount.key);
		mount.live = canvas;
		mount.sheet.appendChild(canvas);
		// Offscreen pages retain a tiny hit target, but no expensive 2D context.
		this.makeInputDormant(mount);
	}

	private wireInputIfPossible(mount: NotebookPageMount): void {
		if (!mount.live || mount.inputWired) return;
		if (!mount.live.getContext('2d')) {
			this.showCanvasUnavailable(mount);
			this.scheduleContextRetry(mount);
			return;
		}
		mount.disposeInput = this.wireOverlay(mount.live, (forwarder) => {
			mount.inputForwarder = forwarder;
		}) ?? null;
		mount.inputWired = true;
		mount.contextRetryCount = 0;
		mount.errorEl?.remove();
		mount.errorEl = null;
	}

	private makeInputDormant(mount: NotebookPageMount): void {
		const live = mount.live;
		if (!live) return;
		live.width = 1;
		live.height = 1;
		live.style.removeProperty('width');
		live.style.removeProperty('height');
		live.classList.add(LIVE_DORMANT_CLASS);
	}

	private scheduleDeactivation(mount: NotebookPageMount): void {
		if (mount.nearViewport || mount.activePointerId !== null || !mount.persistent) return;
		this.cancelDeactivation(mount);
		const win = mount.sheet.ownerDocument.defaultView;
		if (!win) return;
		mount.deactivationTimer = win.setTimeout(() => {
			mount.deactivationTimer = null;
			if (!mount.nearViewport && mount.activePointerId === null) this.unmountPage(mount.sheet);
		}, this.options.deactivationGraceMs ?? DEACTIVATION_GRACE_MS);
	}

	private cancelDeactivation(mount: NotebookPageMount): void {
		if (mount.deactivationTimer === null) return;
		mount.sheet.ownerDocument.defaultView?.clearTimeout(mount.deactivationTimer);
		mount.deactivationTimer = null;
	}

	private scheduleContextRetry(mount: NotebookPageMount): void {
		if (mount.retryTimer !== null || mount.contextRetryCount >= 5) return;
		const win = mount.sheet.ownerDocument.defaultView;
		if (!win) return;
		const delayMs = Math.min(8000, 500 * (2 ** mount.contextRetryCount));
		mount.contextRetryCount += 1;
		mount.retryTimer = win.setTimeout(() => {
			mount.retryTimer = null;
			if (this.pageMounts.get(mount.sheet) !== mount) return;
			if (mount.nearViewport || mount.activePointerId !== null) this.mountPage(mount.sheet);
		}, delayMs);
	}

	private unmountPage(sheet: HTMLElement, final = false): void {
		const mount = this.pageMounts.get(sheet);
		if (!mount) return;
		this.cancelDeactivation(mount);
		const win = sheet.ownerDocument.defaultView;
		if (mount.retryTimer !== null) win?.clearTimeout(mount.retryTimer);
		mount.retryTimer = null;
		this.diagnostics().record('jot-surface.unmount-page', {
			key: mount.key,
			persistentWidth: mount.persistent?.width ?? null,
			persistentHeight: mount.persistent?.height ?? null,
			liveWidth: mount.live?.width ?? null,
			liveHeight: mount.live?.height ?? null,
		});
		mount.resizeObserver?.disconnect();
		mount.resizeObserver = null;
		if (win && mount.resizeFrame !== null) win.cancelAnimationFrame(mount.resizeFrame);
		mount.resizeFrame = null;
		mount.applyResize = null;
		mount.painted = false;
		if (mount.persistent) this.releaseCanvas(mount.persistent);
		mount.persistent = null;
		mount.disposeInput?.();
		mount.disposeInput = null;
		mount.inputForwarder = null;
		mount.inputWired = false;
		if (final) {
			if (mount.pointerListenersAttached) {
				mount.sheet.removeEventListener('pointerdown', mount.onPointerDown, true);
				for (const event of ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture'] as const) {
					mount.sheet.removeEventListener(event, mount.onPointerContinuation, true);
				}
				mount.pointerListenersAttached = false;
			}
			mount.activePointerId = null;
			if (mount.live) this.releaseCanvas(mount.live);
			mount.live = null;
			mount.errorEl?.remove();
		} else {
			this.makeInputDormant(mount);
		}
	}

	private showCanvasUnavailable(mount: NotebookPageMount): void {
		if (mount.errorEl) return;
		const error = mount.sheet.ownerDocument.createElement('div');
		error.className = CANVAS_ERROR_CLASS;
		error.textContent =
			'Ink canvas is temporarily unavailable. Your saved handwriting data has not been changed.';
		mount.sheet.appendChild(error);
		mount.errorEl = error;
	}

	private releaseCanvas(canvas: HTMLCanvasElement): void {
		canvas.width = 1;
		canvas.height = 1;
		canvas.remove();
	}

	private makeCanvas(doc: Document, className: string, key: string): HTMLCanvasElement {
		const canvas = doc.createElement('canvas');
		canvas.className = className;
		canvas.setAttribute(INK_KEY_ATTR, key);
		return canvas;
	}

	private sizeCanvas(
		canvas: HTMLCanvasElement,
		sheet: HTMLElement,
		mount: NotebookPageMount,
	): boolean {
		const win = sheet.ownerDocument.defaultView ?? window;
		const requestedDpr = devicePixelRatioFor(win);
		canvas.classList.remove(LIVE_DORMANT_CLASS);

		if (this.options.fixedLogicalBackingStore) {
			const effectiveDpr = safeBackingStoreDpr(
				mount.sourceWidth,
				mount.sourceHeight,
				requestedDpr,
				this.options.backingStoreLimits,
			);
			const changed = applyBackingStoreSize(
				canvas,
				mount.sourceWidth,
				mount.sourceHeight,
				effectiveDpr,
			);
			if (changed) {
				const rect = sheet.getBoundingClientRect();
				this.diagnostics().record('jot-surface.fixed-canvas-sized', {
					key: mount.key,
					cssWidth: rect.width,
					cssHeight: rect.height,
					canvasWidth: canvas.width,
					canvasHeight: canvas.height,
					canvasArea: canvas.width * canvas.height,
					effectiveDpr,
				});
			}
			return changed;
		}

		const rect = sheet.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return false;
		const effectiveDpr = safeBackingStoreDpr(
			rect.width,
			rect.height,
			requestedDpr,
			this.options.backingStoreLimits,
		);
		return applyBackingStoreSize(canvas, rect.width, rect.height, effectiveDpr);
	}

	private persistentCanvasFor(canvas: HTMLCanvasElement): HTMLCanvasElement | null {
		if (canvas.classList.contains(PERSISTENT_CLASS)) return canvas;
		return (
			canvas.parentElement?.querySelector<HTMLCanvasElement>(`canvas.${PERSISTENT_CLASS}`) ??
			null
		);
	}

	private liveCanvasFor(canvas: HTMLCanvasElement): HTMLCanvasElement | null {
		if (canvas.classList.contains(LIVE_CLASS)) return canvas;
		return (
			canvas.parentElement?.querySelector<HTMLCanvasElement>(`canvas.${LIVE_CLASS}`) ?? null
		);
	}

	private diagnostics(): DiagnosticSink {
		return this.options.diagnostics ?? NULL_DIAGNOSTICS;
	}
}
