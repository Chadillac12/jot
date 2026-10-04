import {
	applyBackingStoreSize,
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
const PERSISTENT_CLASS = 'jot-note-ink';
const LIVE_CLASS = 'jot-note-live-ink';

export class JotNoteSurface implements InkSurfaceController {
	private observers: ResizeObserver[] = [];
	private frames = new Set<number>();

	constructor(
		private host: HTMLElement,
		private strokes: StrokeStore,
		private wireOverlay: (canvas: HTMLCanvasElement) => void,
	) {}

	render(note: JotNoteFile, documentPath: string): void {
		this.disconnect();
		this.host.replaceChildren();

		note.pages.forEach((page, index) => {
			this.renderPage(note, page, documentPath, index);
		});
	}

	setPaperStyle(style: JotNoteFile['paper']): void {
		const classes = ['jot-note-paper-blank', 'jot-note-paper-ruled', 'jot-note-paper-grid', 'jot-note-paper-dot'];
		for (const sheet of Array.from(this.host.querySelectorAll<HTMLElement>(`.${SHEET_CLASS}`))) {
			sheet.classList.remove(...classes);
			sheet.classList.add(`jot-note-paper-${style}`);
		}
	}

	redrawAll(): void {
		this.host
			.querySelectorAll<HTMLCanvasElement>(`canvas.${PERSISTENT_CLASS}`)
			.forEach((canvas) => this.redrawPage(canvas));
	}

	disconnect(): void {
		for (const observer of this.observers) observer.disconnect();
		this.observers = [];
		const win = this.host.ownerDocument.defaultView;
		if (win) {
			for (const frame of this.frames) win.cancelAnimationFrame(frame);
		}
		this.frames.clear();
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
		sheet.className = `${SHEET_CLASS} jot-note-paper-${note.paper}`;
		const paperSpacing = 64;
		sheet.setCssStyles({
			aspectRatio: `${page.width} / ${page.height}`,
		});
		sheet.style.setProperty('--jot-paper-x', `${(paperSpacing / page.width) * 100}%`);
		sheet.style.setProperty('--jot-paper-y', `${(paperSpacing / page.height) * 100}%`);
		wrapper.appendChild(sheet);

		const key = documentPageKey(documentPath, page.id);
		const persistent = this.makeCanvas(doc, PERSISTENT_CLASS, key);
		const live = this.makeCanvas(doc, LIVE_CLASS, key);
		sheet.appendChild(persistent);
		sheet.appendChild(live);
		this.wireOverlay(live);
		this.host.appendChild(wrapper);

		const applyResize = () => {
			const persistentChanged = this.sizeCanvas(persistent, sheet);
			const liveChanged = this.sizeCanvas(live, sheet);
			if (!persistentChanged && !liveChanged) return;
			this.redrawPage(persistent);
			this.clearLivePage(live);
		};

		let resizeFrame: number | null = null;
		const scheduleResize = () => {
			const win = doc.defaultView;
			if (!win) {
				applyResize();
				return;
			}
			if (resizeFrame !== null) return;
			const frame = win.requestAnimationFrame(() => {
				this.frames.delete(frame);
				resizeFrame = null;
				applyResize();
			});
			resizeFrame = frame;
			this.frames.add(frame);
		};

		const observer = new ResizeObserver(scheduleResize);
		observer.observe(sheet);
		this.observers.push(observer);
		scheduleResize();
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
		const effectiveDpr = safeBackingStoreDpr(rect.width, rect.height, requestedDpr);
		// Canvas CSS sizing is handled entirely by the stylesheet (100% x 100%).
		// Only mutate the backing store when its pixel dimensions truly change;
		// repeatedly writing CSS pixel sizes from ResizeObserver can create a
		// WebKit resize/repaint feedback loop on iPad.
		return applyBackingStoreSize(canvas, rect.width, rect.height, effectiveDpr);
	}

	private persistentCanvasFor(canvas: HTMLCanvasElement): HTMLCanvasElement | null {
		if (canvas.classList.contains(PERSISTENT_CLASS)) return canvas;
		return canvas.parentElement?.querySelector<HTMLCanvasElement>(`canvas.${PERSISTENT_CLASS}`) ?? null;
	}

	private liveCanvasFor(canvas: HTMLCanvasElement): HTMLCanvasElement | null {
		if (canvas.classList.contains(LIVE_CLASS)) return canvas;
		return canvas.parentElement?.querySelector<HTMLCanvasElement>(`canvas.${LIVE_CLASS}`) ?? null;
	}
}
