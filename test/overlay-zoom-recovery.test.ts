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
	return { container, page, manager, wire };
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

	it('resizes the existing overlay after the PDF page zoom changes', () => {
		const { page, manager, wire } = makeHarness();
		manager.attachToActivePdf();
		const overlay = page.querySelector<HTMLCanvasElement>('canvas.jot-overlay');
		expect(overlay?.width).toBe(1600);
		expect(overlay?.height).toBe(2000);

		setRect(page, 1600, 2000);
		ResizeObserverMock.instances[0]?.fire();

		expect(overlay?.style.width).toBe('1600px');
		expect(overlay?.style.height).toBe('2000px');
		expect((overlay?.width ?? 0) * (overlay?.height ?? 0)).toBeLessThanOrEqual(16_777_216);
		expect(wire).toHaveBeenCalledTimes(1);
	});

	it('does not create duplicate overlays across repeated resize notifications', () => {
		const { page, manager } = makeHarness();
		manager.attachToActivePdf();
		setRect(page, 1200, 1500);
		ResizeObserverMock.instances[0]?.fire();
		ResizeObserverMock.instances[0]?.fire();
		ResizeObserverMock.instances[0]?.fire();
		expect(page.querySelectorAll('canvas.jot-overlay')).toHaveLength(1);
	});
});
