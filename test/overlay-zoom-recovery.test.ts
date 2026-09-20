/* @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OverlayManager, OVERLAY_KEY_ATTR } from '../src/overlay-manager';
import { StrokeStore } from '../src/stroke-store';

vi.mock('obsidian', () => ({}));

class ResizeObserverMock {
	static instances: ResizeObserverMock[] = [];
	constructor(private callback: ResizeObserverCallback) {
		ResizeObserverMock.instances.push(this);
	}
	observe(): void {}
	disconnect(): void {}
	unobserve(): void {}
	fire(): void {
		this.callback([], this as unknown as ResizeObserver);
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
	const manager = new OverlayManager(app as any, new StrokeStore(), wire);
	return { container, page, pages, manager, wire };
}

beforeEach(() => {
	vi.useFakeTimers();
	document.body.innerHTML = '';
	ResizeObserverMock.instances = [];
	(globalThis as any).activeDocument = document;
	(globalThis as any).ResizeObserver = ResizeObserverMock;
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

	it('stretches the overlay during live zoom and rebuilds the backing store only after zoom settles', () => {
		const { page, manager, wire } = makeHarness();
		manager.attachToActivePdf();
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
		const { manager } = makeHarness();
		manager.attachToActivePdf();
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

	it('does not redraw every page again when attach is repeated for the same PDF leaf', () => {
		const { manager } = makeHarness();
		manager.attachToActivePdf();
		const redraw = vi.spyOn(manager, 'redrawPage');

		manager.attachToActivePdf();
		manager.attachToActivePdf();

		expect(redraw).not.toHaveBeenCalled();
	});
});
