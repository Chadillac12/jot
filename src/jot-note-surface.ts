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
	private frames: number[] = [];

	constructor(
		private host: HTMLElement,
		private strokes: StrokeStore,
		private wireOverlay: (canvas: HTMLCanvasElement) => void,
	) {}

	render(note: JotNoteFile, documentPath: string): void {
		this.disconnect();
		this.host.empty();

		note.pages.forEach((page, index) => {
			this.renderPage(note, page, documentPath, index);
		});
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
		this.frames = [];
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
			'--jot-paper-x': `${(paperSpacing / page.width) * 100}%`,
			'--jot-paper-y': `${(paperSpacing / page.height) * 100}%`,
		});
		wrapper.appendChild(sheet);

		const key = documentPageKey(documentPath, page.id);
		const persistent = this.makeCanvas(doc, PERSISTENT_CLASS, key);
		const live = this.makeCanvas(doc, LIVE_CLASS, key);
		sheet.appendChild(persistent);
		sheet.appendChild(live);
		this.wireOverlay(live);
		this.host.appendChild(wrapper);

		const resize = () => {
			this.sizeCanvas(persistent, sheet);
			this.sizeCanvas(live, sheet);
			this.redrawPage(persistent);
			this.clearLivePage(live);
		};

		const observer = new ResizeObserver(resize);
		observer.observe(sheet);
		this.observers.push(observer);

		const win = doc.defaultView;
		if (win) {
			const frame = win.requestAnimationFrame(resize);
			this.frames.push(frame);
		} else {
			resize();
		}
	}

	private makeCanvas(doc: Document, className: string, key: string): HTMLCanvasElement {
		const canvas = doc.createElement('canvas');
		canvas.className = className;
		canvas.setAttribute(INK_KEY_ATTR, key);
		return canvas;
	}

	private sizeCanvas(canvas: HTMLCanvasElement, sheet: HTMLElement): void {
		const rect = sheet.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;
		const win = sheet.ownerDocument.defaultView ?? window;
		const requestedDpr = devicePixelRatioFor(win);
		const effectiveDpr = safeBackingStoreDpr(rect.width, rect.height, requestedDpr);
		applyBackingStoreSize(canvas, rect.width, rect.height, effectiveDpr);
		canvas.setCssStyles({
			width: `${rect.width}px`,
			height: `${rect.height}px`,
		});
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
