/* @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OverlayManager, OVERLAY_KEY_ATTR } from '../src/overlay-manager';
import { StrokeStore } from '../src/stroke-store';

vi.mock('obsidian', () => ({}));

class ResizeObserverMock {
	static instances: ResizeObserverMock[] = [];
	disconnect = vi.fn();
	constructor(private callback: ResizeObserverCallback) {
		ResizeObserverMock.instances.push(this);
	}
	observe(): void {}
	unobserve(): void {}
	fire(): void {
		this.callback([], this as unknown as ResizeObserver);
	}
}

class IntersectionObserverMock {
	static instances: IntersectionObserverMock[] = [];
	readonly observed = new Set<Element>();
	disconnect = vi.fn(() => this.observed.clear());
	unobserve = vi.fn((target: Element) => this.observed.delete(target));

	constructor(
		private callback: IntersectionObserverCallback,
		public readonly options?: IntersectionObserverInit,
	) {
		IntersectionObserverMock.instances.push(this);
	}

	observe(target: Element): void {
		this.observed.add(target);
	}

	fire(target: Element, isIntersecting: boolean): void {
		this.callback(
			[
				{
					target,
					isIntersecting,
					intersectionRatio: isIntersecting ? 1 : 0,
				} as IntersectionObserverEntry,
			],
			this as unknown as IntersectionObserver,
		);
	}
}

function setRect(el: HTMLElement, width: number, height: number): void {
	el.getBoundingClientRect = () =>
		({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			right: width,
			bottom: height,
			width,
			height,
			toJSON: () => ({}),
		}) as DOMRect;
}

async function flushMutations(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function makeHarness(pageCount = 1) {
	const container = document.createElement('div');
	const pages = Array.from({ length: pageCount }, (_, index) => {
		const page = document.createElement('div');
		page.className = 'page';
		page.setAttribute('data-page-number', String(index + 1));
		setRect(page, 800, 1000);
		container.appendChild(page);
		return page;
	});
	const page = pages[0];
	if (!page) throw new Error('Harness requires at least one PDF page');
	document.body.appendChild(container);

	const leaf = {
		view: {
			containerEl: container,
			file: { path: 'notes.pdf' },
			getViewType: () => 'pdf',
		},
	};
	const app = {
		workspace: {
			getMostRecentLeaf: () => leaf,
			iterateAllLeaves: (fn: (value: unknown) => void) => fn(leaf),
		},
	};
	const wire = vi.fn();
	const strokes = new StrokeStore();
	const manager = new OverlayManager(app as any, strokes, wire);
	return { container, page, pages, manager, wire, strokes };
}

function activate(page: HTMLElement): void {
	const observer = IntersectionObserverMock.instances[0];
	if (!observer) throw new Error('Expected an IntersectionObserver');
	observer.fire(page, true);
}

function deactivate(page: HTMLElement): void {
	const observer = IntersectionObserverMock.instances[0];
	if (!observer) throw new Error('Expected an IntersectionObserver');
	observer.fire(page, false);
}

beforeEach(() => {
	vi.useFakeTimers();
	document.body.innerHTML = '';
	ResizeObserverMock.instances = [];
	IntersectionObserverMock.instances = [];
	(globalThis as any).activeDocument = document;
	(globalThis as any).ResizeObserver = ResizeObserverMock;
	(globalThis as any).IntersectionObserver = IntersectionObserverMock;
	(globalThis as any).window.devicePixelRatio = 2;
	(HTMLElement.prototype as any).setCssStyles = function (styles: Record<string, string>) {
		Object.assign((this as HTMLElement).style, styles);
	};
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
		setTransform: vi.fn(),
		clearRect: vi.fn(),
	} as any);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('OverlayManager zoom recovery', () => {
	it('recreates and rewires an overlay removed during a PDF.js page rebuild', async () => {
		const { page, manager, wire } = makeHarness();
		manager.attachToActivePdf();
		activate(page);
		const first = page.querySelector<HTMLCanvasElement>('canvas.jot-overlay');
		expect(first).not.toBeNull();
		expect(wire).toHaveBeenCalledTimes(1);

		first?.remove();
		await flushMutations();

		const replacement = page.querySelector<HTMLCanvasElement>('canvas.jot-overlay');
		expect(replacement).not.toBeNull();
		expect(replacement).not.toBe(first);
		expect(replacement?.getAttribute(OVERLAY_KEY_ATTR)).toBe('notes.pdf::1');
		expect(wire).toHaveBeenCalledTimes(2);
	});

	it('does not scan added text-layer subtrees for nested PDF pages', async () => {
		const { page, manager } = makeHarness();
		manager.attachToActivePdf();
		activate(page);
		await flushMutations();

		const textLayer = document.createElement('div');
		textLayer.className = 'textLayer';
		page.appendChild(textLayer);
		await flushMutations();

		const glyphBatch = document.createElement('div');
		for (let i = 0; i < 200; i++) {
			glyphBatch.appendChild(document.createElement('span'));
		}
		const scan = vi.spyOn(glyphBatch, 'querySelectorAll');
		textLayer.appendChild(glyphBatch);
		await flushMutations();

		expect(scan).not.toHaveBeenCalled();
	});

	it('does not inspect removed subtrees from the PDF container observer', async () => {
		const { container, manager } = makeHarness();
		manager.attachToActivePdf();

		const disposable = document.createElement('div');
		disposable.appendChild(document.createElement('span'));
		container.appendChild(disposable);
		await flushMutations();

		const scan = vi.spyOn(disposable, 'querySelectorAll');
		disposable.remove();
		await flushMutations();

		expect(scan).not.toHaveBeenCalled();
	});

	it('stretches the overlay during live zoom and rebuilds the backing store only after zoom settles', () => {
		const { page, manager, wire } = makeHarness();
		manager.attachToActivePdf();
		activate(page);
		const overlay = page.querySelector<HTMLCanvasElement>('canvas.jot-overlay');
		expect(overlay?.width).toBe(1600);
		expect(overlay?.height).toBe(2000);

		setRect(page, 1600, 2000);
		ResizeObserverMock.instances[0]?.fire();

		// CSS follows the live pinch immediately, but the expensive bitmap
		// allocation remains untouched until the gesture has gone quiet.
		expect(overlay?.style.width).toBe('1600px');
		expect(overlay?.style.height).toBe('2000px');
		expect(overlay?.width).toBe(1600);
		expect(overlay?.height).toBe(2000);

		vi.advanceTimersByTime(119);
		expect(overlay?.width).toBe(1600);
		vi.advanceTimersByTime(1);

		expect(overlay?.width).toBe(3200);
		expect(overlay?.height).toBe(4000);
		expect((overlay?.width ?? 0) * (overlay?.height ?? 0)).toBeLessThanOrEqual(16_777_216);
		expect(wire).toHaveBeenCalledTimes(1);
	});

	it('coalesces repeated resize notifications into one settled backing-store update', () => {
		const { page, manager } = makeHarness();
		manager.attachToActivePdf();
		activate(page);
		const overlay = page.querySelector<HTMLCanvasElement>('canvas.jot-overlay');

		setRect(page, 1000, 1250);
		ResizeObserverMock.instances[0]?.fire();
		setRect(page, 1200, 1500);
		ResizeObserverMock.instances[0]?.fire();
		setRect(page, 1400, 1750);
		ResizeObserverMock.instances[0]?.fire();

		expect(page.querySelectorAll('canvas.jot-overlay')).toHaveLength(1);
		expect(overlay?.width).toBe(1600);
		vi.advanceTimersByTime(120);
		expect(overlay?.style.width).toBe('1400px');
		expect(overlay?.style.height).toBe('1750px');
		expect(overlay?.width).not.toBe(1600);
	});

	it('does not schedule settled work when a resize notification reports the same size', () => {
		const { page, manager } = makeHarness();
		manager.attachToActivePdf();
		activate(page);
		const redraw = vi.spyOn(manager, 'redrawPage');

		ResizeObserverMock.instances[0]?.fire();

		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(500);
		expect(redraw).not.toHaveBeenCalled();
	});

	it('shares one settle timer across multiple pages resized by the same pinch', () => {
		const { pages, manager } = makeHarness(2);
		const first = pages[0];
		const second = pages[1];
		if (!first || !second) throw new Error('Expected two PDF pages');
		manager.attachToActivePdf();
		activate(first);
		activate(second);

		setRect(first, 1000, 1250);
		setRect(second, 1000, 1250);
		ResizeObserverMock.instances[0]?.fire();
		ResizeObserverMock.instances[1]?.fire();

		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(120);

		const firstOverlay = first.querySelector<HTMLCanvasElement>('canvas.jot-overlay');
		const secondOverlay = second.querySelector<HTMLCanvasElement>('canvas.jot-overlay');
		expect(firstOverlay?.style.width).toBe('1000px');
		expect(secondOverlay?.style.width).toBe('1000px');
	});

	it('registers a large PDF without allocating Jot canvases up front', () => {
		const { container, pages, manager, wire } = makeHarness(81);
		manager.attachToActivePdf();

		const observer = IntersectionObserverMock.instances[0];
		expect(observer?.observed.size).toBe(81);
		expect(container.querySelectorAll('canvas.jot-overlay')).toHaveLength(0);
		expect(ResizeObserverMock.instances).toHaveLength(0);
		expect(wire).not.toHaveBeenCalled();

		activate(pages[0]!);
		activate(pages[1]!);
		activate(pages[2]!);

		expect(container.querySelectorAll('canvas.jot-overlay')).toHaveLength(3);
		expect(ResizeObserverMock.instances).toHaveLength(3);
		expect(wire).toHaveBeenCalledTimes(3);
	});

	it('reports only materialized pages in overlay memory totals', () => {
		const { pages, manager } = makeHarness(81);
		manager.attachToActivePdf();
		activate(pages[0]!);
		activate(pages[1]!);
		activate(pages[2]!);

		const report = manager.zoomDiagnosticsSnapshot().join('\n');
		expect(report).toContain('pages=81');
		expect(report).toContain('overlays=3');
		expect(report).toContain('activePages=3');
		expect(report).toContain('inactivePages=78');
		expect(report).toContain('estimatedRgbaMiB=');
	});

	it('deactivates distant pages and releases their backing stores', () => {
		const { page, manager } = makeHarness();
		const textLayer = document.createElement('div');
		textLayer.className = 'textLayer';
		const annotationLayer = document.createElement('div');
		annotationLayer.className = 'annotationLayer';
		page.append(textLayer, annotationLayer);

		manager.attachToActivePdf();
		activate(page);

		const overlay = page.querySelector<HTMLCanvasElement>('canvas.jot-overlay');
		expect(overlay?.width).toBe(1600);
		expect(page.getAttribute('data-jot-observed')).toBe('1');
		expect(textLayer.classList.contains('jot-passthrough')).toBe(true);

		deactivate(page);
		expect(page.querySelector('canvas.jot-overlay')).not.toBeNull();
		vi.advanceTimersByTime(750);

		expect(page.querySelector('canvas.jot-overlay')).toBeNull();
		expect(overlay?.width).toBe(0);
		expect(overlay?.height).toBe(0);
		expect(page.hasAttribute('data-jot-observed')).toBe(false);
		expect(textLayer.classList.contains('jot-passthrough')).toBe(false);
		expect(annotationLayer.classList.contains('jot-passthrough')).toBe(false);
		expect(ResizeObserverMock.instances[0]?.disconnect).toHaveBeenCalledTimes(1);
	});

	it('keeps the same overlay when a zoom briefly moves the page outside the lazy window', () => {
		const { page, manager, wire } = makeHarness();
		manager.attachToActivePdf();
		activate(page);
		const first = page.querySelector<HTMLCanvasElement>('canvas.jot-overlay');

		deactivate(page);
		vi.advanceTimersByTime(500);
		activate(page);
		vi.advanceTimersByTime(500);
		const second = page.querySelector<HTMLCanvasElement>('canvas.jot-overlay');

		expect(second).toBe(first);
		expect(wire).toHaveBeenCalledTimes(1);
	});

	it('replaces a stale overlay from an older plugin instance instead of reusing it', () => {
		const { page, manager, wire } = makeHarness();
		const stale = document.createElement('canvas');
		stale.className = 'jot-overlay';
		stale.setAttribute(OVERLAY_KEY_ATTR, 'notes.pdf::1');
		page.appendChild(stale);

		manager.attachToActivePdf();
		activate(page);

		const current = page.querySelector<HTMLCanvasElement>('canvas.jot-overlay');
		expect(current).not.toBeNull();
		expect(current).not.toBe(stale);
		expect(stale.width).toBe(0);
		expect(stale.height).toBe(0);
		expect(wire).toHaveBeenCalledTimes(1);
	});

	it('does not retire an overlay while a Pencil pointer owns it', () => {
		const { page, manager } = makeHarness();
		manager.attachToActivePdf();
		activate(page);
		const overlay = page.querySelector<HTMLCanvasElement>('canvas.jot-overlay');
		if (!overlay) throw new Error('Expected active overlay');

		manager.pinOverlay(overlay);
		deactivate(page);
		vi.advanceTimersByTime(1500);
		expect(page.querySelector('canvas.jot-overlay')).toBe(overlay);

		manager.unpinOverlay(overlay);
		vi.advanceTimersByTime(300);
		expect(page.querySelector('canvas.jot-overlay')).toBeNull();
	});

	it('roots lazy visibility to the native PDF scroll viewport when available', () => {
		const { container, pages, manager } = makeHarness(2);
		const scrollRoot = document.createElement('div');
		scrollRoot.className = 'pdf-viewer-container';
		for (const page of pages) scrollRoot.appendChild(page);
		container.appendChild(scrollRoot);

		manager.attachToActivePdf();

		const observer = IntersectionObserverMock.instances[0];
		expect(observer?.options?.root).toBe(scrollRoot);
		expect(observer?.options?.rootMargin).toBe('1200px 0px');
	});

	it('disconnects lazy page observers and removes canvases on plugin shutdown', () => {
		const { page, manager } = makeHarness();
		manager.attachToActivePdf();
		activate(page);

		const intersection = IntersectionObserverMock.instances[0];
		const resize = ResizeObserverMock.instances[0];
		expect(page.querySelector('canvas.jot-overlay')).not.toBeNull();

		manager.disconnectAll();

		expect(intersection?.disconnect).toHaveBeenCalledTimes(1);
		expect(resize?.disconnect).toHaveBeenCalledTimes(1);
		expect(page.querySelector('canvas.jot-overlay')).toBeNull();
		expect(page.hasAttribute('data-jot-observed')).toBe(false);
	});

	it('does not redraw every page again when attach is repeated for the same PDF leaf', () => {
		const { manager } = makeHarness();
		manager.attachToActivePdf();
		const redraw = vi.spyOn(manager, 'redrawPage');

		manager.attachToActivePdf();
		manager.attachToActivePdf();

		expect(redraw).not.toHaveBeenCalled();
	});
});
