/* @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OverlayManager, OVERLAY_KEY_ATTR } from '../src/overlay-manager';
import { StrokeStore } from '../src/stroke-store';

vi.mock('obsidian', () => ({}));

class ResizeObserverMock {
	static instances: ResizeObserverMock[] = [];
	private targets = new Set<Element>();

	constructor(private callback: ResizeObserverCallback) {
		ResizeObserverMock.instances.push(this);
	}

	observe(target: Element): void {
		this.targets.add(target);
	}

	disconnect(): void {
		this.targets.clear();
	}

	unobserve(target: Element): void {
		this.targets.delete(target);
	}

	fire(): void {
		this.callback([], this as unknown as ResizeObserver);
	}
}

class IntersectionObserverMock {
	static instances: IntersectionObserverMock[] = [];
	readonly targets = new Set<Element>();

	constructor(
		private callback: IntersectionObserverCallback,
		public readonly options?: IntersectionObserverInit,
	) {
		IntersectionObserverMock.instances.push(this);
	}

	observe(target: Element): void {
		this.targets.add(target);
	}

	disconnect(): void {
		this.targets.clear();
	}

	unobserve(target: Element): void {
		this.targets.delete(target);
	}

	takeRecords(): IntersectionObserverEntry[] {
		return [];
	}

	fire(target: Element, isIntersecting: boolean): void {
		if (!this.targets.has(target)) return;
		const rect = target.getBoundingClientRect();
		this.callback(
			[
				{
					time: 0,
					target,
					rootBounds: null,
					boundingClientRect: rect,
					intersectionRect: isIntersecting ? rect : emptyRect(),
					isIntersecting,
					intersectionRatio: isIntersecting ? 1 : 0,
				} as IntersectionObserverEntry,
			],
			this as unknown as IntersectionObserver,
		);
	}
}

function emptyRect(): DOMRectReadOnly {
	return {
		x: 0,
		y: 0,
		left: 0,
		top: 0,
		right: 0,
		bottom: 0,
		width: 0,
		height: 0,
		toJSON: () => ({}),
	} as DOMRectReadOnly;
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

function intersection(): IntersectionObserverMock {
	const observer = IntersectionObserverMock.instances[0];
	if (!observer) throw new Error('Expected an IntersectionObserver');
	return observer;
}

beforeEach(() => {
	vi.useFakeTimers();
	document.body.innerHTML = '';
	ResizeObserverMock.instances = [];
	IntersectionObserverMock.instances = [];
	(globalThis as any).activeDocument = document;
	(globalThis as any).ResizeObserver = ResizeObserverMock;
	(globalThis as any).IntersectionObserver = IntersectionObserverMock;
	Object.defineProperty(window, 'IntersectionObserver', {
		value: IntersectionObserverMock,
		configurable: true,
		writable: true,
	});
	(globalThis as any).window.devicePixelRatio = 2;
	(HTMLElement.prototype as any).setCssStyles = function (styles: Record<string, string>) {
		Object.assign((this as HTMLElement).style, styles);
	};
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
		setTransform: vi.fn(),
		clearRect: vi.fn(),
		beginPath: vi.fn(),
		moveTo: vi.fn(),
		lineTo: vi.fn(),
		stroke: vi.fn(),
		save: vi.fn(),
		restore: vi.fn(),
	} as any);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('OverlayManager lazy PDF overlays', () => {
	it('registers a long PDF without allocating a canvas for every page', () => {
		const { pages, container, manager, wire } = makeHarness(81);
		manager.attachToActivePdf();

		expect(intersection().targets.size).toBe(81);
		expect(container.querySelectorAll('canvas.jot-overlay')).toHaveLength(0);
		expect(ResizeObserverMock.instances).toHaveLength(0);
		expect(wire).not.toHaveBeenCalled();

		intersection().fire(pages[0]!, true);
		intersection().fire(pages[1]!, true);
		intersection().fire(pages[2]!, true);

		expect(container.querySelectorAll('canvas.jot-overlay')).toHaveLength(3);
		expect(ResizeObserverMock.instances).toHaveLength(3);
		expect(wire).toHaveBeenCalledTimes(3);
	});

	it('removes the backing canvas and observers when a page leaves the prefetch window', () => {
		const { page, manager } = makeHarness();
		const textLayer = document.createElement('div');
		textLayer.className = 'textLayer';
		page.appendChild(textLayer);
		manager.attachToActivePdf();
		intersection().fire(page, true);

		expect(page.querySelector('canvas.jot-overlay')).not.toBeNull();
		expect(page.getAttribute('data-jot-observed')).toBe('1');
		expect(textLayer.classList.contains('jot-passthrough')).toBe(true);

		intersection().fire(page, false);

		expect(page.querySelector('canvas.jot-overlay')).toBeNull();
		expect(page.hasAttribute('data-jot-observed')).toBe(false);
		expect(textLayer.classList.contains('jot-passthrough')).toBe(false);
	});

	it('recreates and rewires an active overlay removed during a PDF.js page rebuild', async () => {
		const { page, manager, wire } = makeHarness();
		manager.attachToActivePdf();
		intersection().fire(page, true);
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

	it('keeps stored strokes when an overlay is evicted and redraws on reactivation', () => {
		const { page, manager, strokes, wire } = makeHarness();
		strokes.appendToKey('notes.pdf::1', {
			points: [
				{ x: 0.1, y: 0.1, pressure: 0.5 },
				{ x: 0.2, y: 0.2, pressure: 0.5 },
			],
			color: '#000000',
			width: 0.0025,
			tool: 'pen',
		});

		manager.attachToActivePdf();
		intersection().fire(page, true);
		const first = page.querySelector<HTMLCanvasElement>('canvas.jot-overlay');
		expect(first).not.toBeNull();

		intersection().fire(page, false);
		expect(page.querySelector('canvas.jot-overlay')).toBeNull();
		expect(strokes.forKey('notes.pdf::1')).toHaveLength(1);

		intersection().fire(page, true);
		const second = page.querySelector<HTMLCanvasElement>('canvas.jot-overlay');
		expect(second).not.toBeNull();
		expect(second).not.toBe(first);
		expect(second?.getAttribute(OVERLAY_KEY_ATTR)).toBe('notes.pdf::1');
		expect(strokes.forKey('notes.pdf::1')).toHaveLength(1);
		expect(wire).toHaveBeenCalledTimes(2);
	});

	it('replaces the registered page node for the same PDF page without keeping the old canvas alive', async () => {
		const { container, page, manager } = makeHarness();
		manager.attachToActivePdf();
		intersection().fire(page, true);
		expect(page.querySelector('canvas.jot-overlay')).not.toBeNull();

		const replacement = document.createElement('div');
		replacement.className = 'page';
		replacement.setAttribute('data-page-number', '1');
		setRect(replacement, 800, 1000);
		container.appendChild(replacement);
		await flushMutations();

		expect(page.querySelector('canvas.jot-overlay')).toBeNull();
		expect(intersection().targets.has(page)).toBe(false);
		expect(intersection().targets.has(replacement)).toBe(true);

		intersection().fire(replacement, true);
		expect(replacement.querySelector('canvas.jot-overlay')).not.toBeNull();
	});

	it('stretches an active overlay during live zoom and rebuilds the backing store only after settle', () => {
		const { page, manager, wire } = makeHarness();
		manager.attachToActivePdf();
		intersection().fire(page, true);
		const overlay = page.querySelector<HTMLCanvasElement>('canvas.jot-overlay');
		expect(overlay?.width).toBe(1600);
		expect(overlay?.height).toBe(2000);

		setRect(page, 1600, 2000);
		ResizeObserverMock.instances[0]?.fire();

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
		intersection().fire(page, true);
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

	it('does not schedule settled work when an active resize reports the same size', () => {
		const { page, manager } = makeHarness();
		manager.attachToActivePdf();
		intersection().fire(page, true);
		const redraw = vi.spyOn(manager, 'redrawPage');
		redraw.mockClear();

		ResizeObserverMock.instances[0]?.fire();

		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(500);
		expect(redraw).not.toHaveBeenCalled();
	});

	it('shares one settle timer only across materialized pages resized by the same pinch', () => {
		const { pages, manager } = makeHarness(6);
		const first = pages[0]!;
		const second = pages[1]!;
		manager.attachToActivePdf();
		intersection().fire(first, true);
		intersection().fire(second, true);

		expect(ResizeObserverMock.instances).toHaveLength(2);
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
		expect(pages.slice(2).every((page) => page.querySelector('canvas.jot-overlay') === null)).toBe(true);
	});

	it('cancels pending resize work when a page is evicted', () => {
		const { page, manager } = makeHarness();
		manager.attachToActivePdf();
		intersection().fire(page, true);
		setRect(page, 1200, 1500);
		ResizeObserverMock.instances[0]?.fire();
		expect(vi.getTimerCount()).toBe(1);

		intersection().fire(page, false);

		expect(vi.getTimerCount()).toBe(0);
		expect(page.querySelector('canvas.jot-overlay')).toBeNull();
	});

	it('does not redraw every page again when attach is repeated for the same PDF leaf', () => {
		const { page, manager } = makeHarness();
		manager.attachToActivePdf();
		intersection().fire(page, true);
		const redraw = vi.spyOn(manager, 'redrawPage');
		redraw.mockClear();

		manager.attachToActivePdf();
		manager.attachToActivePdf();

		expect(redraw).not.toHaveBeenCalled();
		expect(IntersectionObserverMock.instances).toHaveLength(1);
	});
});
