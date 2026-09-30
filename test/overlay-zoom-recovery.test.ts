/* @vitest-environment happy-dom */
/* eslint-disable obsidianmd/prefer-active-doc, @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

function makeHarness() {
	const container = document.createElement('div');
	const page = document.createElement('div');
	page.className = 'page';
	page.setAttribute('data-page-number', '1');
	setRect(page, 800, 1000);
	container.appendChild(page);
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
	return { page, manager, wire };
}

beforeEach(() => {
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

describe('OverlayManager zoom recovery', () => {
	it('recreates and rewires a live ink layer removed during a PDF.js rebuild', async () => {
		const { page, manager, wire } = makeHarness();
		manager.attachToActivePdf();
		const persistent = page.querySelector<HTMLCanvasElement>('canvas.jot-overlay');
		const firstLive = page.querySelector<HTMLCanvasElement>('canvas.jot-live-overlay');
		expect(persistent).not.toBeNull();
		expect(firstLive).not.toBeNull();
		expect(wire).toHaveBeenCalledTimes(1);

		firstLive?.remove();
		await flushMutations();

		const replacement = page.querySelector<HTMLCanvasElement>('canvas.jot-live-overlay');
		expect(replacement).not.toBeNull();
		expect(replacement).not.toBe(firstLive);
		expect(replacement?.getAttribute(OVERLAY_KEY_ATTR)).toBe('notes.pdf::1');
		expect(wire).toHaveBeenCalledTimes(2);
	});

	it('recreates the persistent layer without duplicating the live handler', async () => {
		const { page, manager, wire } = makeHarness();
		manager.attachToActivePdf();
		const first = page.querySelector<HTMLCanvasElement>('canvas.jot-overlay');
		first?.remove();
		await flushMutations();

		expect(page.querySelectorAll('canvas.jot-overlay')).toHaveLength(1);
		expect(page.querySelectorAll('canvas.jot-live-overlay')).toHaveLength(1);
		expect(wire).toHaveBeenCalledTimes(1);
	});

	it('resizes both layers safely after PDF zoom changes', () => {
		const { page, manager } = makeHarness();
		manager.attachToActivePdf();
		setRect(page, 2400, 3200);
		ResizeObserverMock.instances[0]?.fire();

		const persistent = page.querySelector<HTMLCanvasElement>('canvas.jot-overlay');
		const live = page.querySelector<HTMLCanvasElement>('canvas.jot-live-overlay');
		for (const canvas of [persistent, live]) {
			expect(canvas?.style.width).toBe('2400px');
			expect(canvas?.style.height).toBe('3200px');
			expect((canvas?.width ?? 0) * (canvas?.height ?? 0)).toBeLessThanOrEqual(16_777_216);
		}
	});
});
