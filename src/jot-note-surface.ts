import {
	applyBackingStoreSize,
	type CanvasBackingStoreLimits,
	devicePixelRatioFor,
	readCanvasSurface,
	safeBackingStoreDpr,
} from './canvas-surface';
import { INK_KEY_ATTR, type InkSurfaceController } from './ink-surface';
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

export interface JotNoteSurfaceOptions {
	observerRoot?: Element;
	eagerMountFirstPage?: boolean;
	rootMargin?: string;
	backingStoreLimits?: CanvasBackingStoreLimits;
}

interface NotebookPageMount {
	sheet: HTMLElement;
	key: string;
	persistent: HTMLCanvasElement | null;
	live: HTMLCanvasElement | null;
	resizeObserver: ResizeObserver | null;
	resizeFrame: number | null;
	painted: boolean;
	disposeInput: (() => void) | null;
	errorEl: HTMLElement | null;
}

export class JotNoteSurface implements InkSurfaceController {
	private intersectionObserver: IntersectionObserver | null = null;
	private pageMounts = new Map<HTMLElement, NotebookPageMount>();

	constructor(
		private host: HTMLElement,
		private strokes: StrokeStore,
		private wireOverlay: (canvas: HTMLCanvasElement) => (() => void) | void,
		private options: JotNoteSurfaceOptions = {},
	) {}

	render(note: JotNoteFile, documentPath: string): void {
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
		for (const sheet of [...this.pageMounts.keys()]) this.unmountPage(sheet);
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
						this.mountPage(sheet);
					} else {
						this.unmountPage(sheet);
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
			persistent: null,
			live: null,
			resizeObserver: null,
			resizeFrame: null,
			painted: false,
			disposeInput: null,
			errorEl: null,
		};
		this.pageMounts.set(sheet, mount);
		this.host.appendChild(wrapper);

		if (this.intersectionObserver) {
			this.intersectionObserver.observe(sheet);
			if (index === 0 && (this.options.eagerMountFirstPage ?? true)) {
				this.mountPage(sheet);
			}
		} else {
			this.mountPage(sheet);
		}
	}

	private mountPage(sheet: HTMLElement): void {
		const mount = this.pageMounts.get(sheet);
		if (!mount || mount.persistent || mount.live) return;

		const doc = sheet.ownerDocument;
		const persistent = this.makeCanvas(doc, PERSISTENT_CLASS, mount.key);
		const live = this.makeCanvas(doc, LIVE_CLASS, mount.key);
		sheet.appendChild(persistent);
		sheet.appendChild(live);
		mount.persistent = persistent;
		mount.live = live;

		const persistentCtx = persistent.getContext('2d');
		const liveCtx = live.getContext('2d');
		if (!persistentCtx || !liveCtx) {
			this.showCanvasUnavailable(mount);
			return;
		}
		mount.errorEl?.remove();
		mount.errorEl = null;

		const disposeInput = this.wireOverlay(live);
		mount.disposeInput = disposeInput ?? null;

		const applyResize = () => {
			if (!mount.persistent || !mount.live) return;
			const persistentChanged = this.sizeCanvas(mount.persistent, sheet);
			const liveChanged = this.sizeCanvas(mount.live, sheet);
			if (!persistentChanged && !liveChanged && mount.painted) return;
			mount.painted = true;
			this.redrawPage(mount.persistent);
			this.clearLivePage(mount.live);
		};

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

		const ResizeObserverCtor = doc.defaultView?.ResizeObserver;
		if (ResizeObserverCtor) {
			mount.resizeObserver = new ResizeObserverCtor(scheduleResize);
			mount.resizeObserver.observe(sheet);
		}
		scheduleResize();
	}

	private unmountPage(sheet: HTMLElement): void {
		const mount = this.pageMounts.get(sheet);
		if (!mount) return;
		mount.disposeInput?.();
		mount.disposeInput = null;
		mount.resizeObserver?.disconnect();
		mount.resizeObserver = null;

		const win = sheet.ownerDocument.defaultView;
		if (win && mount.resizeFrame !== null) win.cancelAnimationFrame(mount.resizeFrame);
		mount.resizeFrame = null;
		mount.painted = false;

		if (mount.persistent) this.releaseCanvas(mount.persistent);
		if (mount.live) this.releaseCanvas(mount.live);
		mount.persistent = null;
		mount.live = null;
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

	private sizeCanvas(canvas: HTMLCanvasElement, sheet: HTMLElement): boolean {
		const rect = sheet.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return false;
		const win = sheet.ownerDocument.defaultView ?? window;
		const requestedDpr = devicePixelRatioFor(win);
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
}
