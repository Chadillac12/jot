/* @vitest-environment happy-dom */
/* eslint-disable
	@typescript-eslint/no-explicit-any,
	@typescript-eslint/no-unsafe-member-access,
	@typescript-eslint/no-unsafe-argument,
	@typescript-eslint/unbound-method,
	obsidianmd/no-global-this,
	obsidianmd/prefer-active-doc
*/
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PdfPageBinding } from '../src/pdf-page-binding';
import { StrokeStore } from '../src/stroke-store';

class ResizeObserverMock {
	static instances: ResizeObserverMock[] = [];
	disconnected = false;
	constructor(private callback: ResizeObserverCallback) {
		ResizeObserverMock.instances.push(this);
	}
	observe(): void {}
	disconnect(): void {
		this.disconnected = true;
	}
	unobserve(): void {}
	fire(): void {
		this.callback([], this);
	}
}

class MutationObserverMock {
	static instances: MutationObserverMock[] = [];
	disconnected = false;
	constructor(private callback: MutationCallback) {
		MutationObserverMock.instances.push(this);
	}
	observe(): void {}
	disconnect(): void {
		this.disconnected = true;
	}
	takeRecords(): MutationRecord[] {
		return [];
	}
	fire(): void {
		this.callback([], this);
	}
}

function page(): HTMLElement {
	const el = document.createElement('div');
	el.className = 'page';
	el.setAttribute('data-page-number', '1');
	el.getBoundingClientRect = () =>
		({
			left: 0,
			top: 0,
			right: 800,
			bottom: 1000,
			width: 800,
			height: 1000,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		});
	document.body.appendChild(el);
	return el;
}

beforeEach(() => {
	document.body.replaceChildren();
	ResizeObserverMock.instances = [];
	MutationObserverMock.instances = [];
	(globalThis as any).ResizeObserver = ResizeObserverMock;
	(globalThis as any).MutationObserver = MutationObserverMock;
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
		setTransform: vi.fn(),
		clearRect: vi.fn(),
		save: vi.fn(),
		restore: vi.fn(),
		beginPath: vi.fn(),
		moveTo: vi.fn(),
		lineTo: vi.fn(),
		quadraticCurveTo: vi.fn(),
		closePath: vi.fn(),
		fill: vi.fn(),
		stroke: vi.fn(),
	} as unknown as CanvasRenderingContext2D);
	window.requestAnimationFrame = (callback: FrameRequestCallback) => {
		callback(0);
		return 1;
	};
	window.cancelAnimationFrame = vi.fn();
});

describe('PdfPageBinding', () => {
	it('owns exactly one persistent layer, one live layer, and one input handler', () => {
		const el = page();
		const disposeInput = vi.fn();
		const wire = vi.fn(() => disposeInput);
		const binding = new PdfPageBinding(el, 'notes.pdf', new StrokeStore(), wire);

		expect(el.querySelectorAll('canvas.jot-overlay')).toHaveLength(1);
		expect(el.querySelectorAll('canvas.jot-live-overlay')).toHaveLength(1);
		expect(wire).toHaveBeenCalledTimes(1);
		expect(binding.key).toBe('notes.pdf::1');
	});

	it('disposes observers, input handlers, canvases, and Jot-owned classes', () => {
		const el = page();
		const textLayer = document.createElement('div');
		textLayer.className = 'textLayer';
		el.appendChild(textLayer);
		const annotationLayer = document.createElement('div');
		annotationLayer.className = 'annotationLayer';
		el.appendChild(annotationLayer);
		const disposeInput = vi.fn();
		const binding = new PdfPageBinding(
			el,
			'notes.pdf',
			new StrokeStore(),
			() => disposeInput,
		);

		binding.dispose();

		expect(disposeInput).toHaveBeenCalledTimes(1);
		expect(ResizeObserverMock.instances[0]?.disconnected).toBe(true);
		expect(MutationObserverMock.instances[0]?.disconnected).toBe(true);
		expect(el.querySelector('.jot-overlay')).toBeNull();
		expect(el.querySelector('.jot-live-overlay')).toBeNull();
		expect(el.classList.contains('jot-page-anchor')).toBe(false);
		expect(el.querySelector('.textLayer')?.classList.contains('jot-passthrough')).toBe(false);
		expect(el.querySelector('.annotationLayer')?.classList.contains('jot-passthrough')).toBe(false);
	});

	it('replaces a removed live canvas and disposes the stale pointer handler', () => {
		const el = page();
		const firstDispose = vi.fn();
		const secondDispose = vi.fn();
		const wire = vi
			.fn<() => () => void>()
			.mockReturnValueOnce(firstDispose)
			.mockReturnValueOnce(secondDispose);
		new PdfPageBinding(el, 'notes.pdf', new StrokeStore(), wire);
		const firstLive = el.querySelector<HTMLCanvasElement>('canvas.jot-live-overlay');
		firstLive?.remove();

		MutationObserverMock.instances[0]?.fire();

		const replacement = el.querySelector<HTMLCanvasElement>('canvas.jot-live-overlay');
		expect(replacement).not.toBe(firstLive);
		expect(firstDispose).toHaveBeenCalledTimes(1);
		expect(wire).toHaveBeenCalledTimes(2);
	});

	it('does not redraw on resize callbacks when backing dimensions are unchanged', () => {
		const el = page();
		const strokes = new StrokeStore();
		strokes.setForKey('notes.pdf::1', [
			{
				points: [
					{ x: 0.1, y: 0.1, pressure: 0.5 },
					{ x: 0.2, y: 0.2, pressure: 0.5 },
				],
				color: '#000000',
				width: 0.0025,
				tool: 'pen',
			},
		]);
		const binding = new PdfPageBinding(el, 'notes.pdf', strokes, () => () => {});
		const ctx = binding.persistentCanvas?.getContext('2d');
		const clearRect = vi.mocked(ctx!.clearRect);
		const afterInitial = clearRect.mock.calls.length;

		ResizeObserverMock.instances[0]?.fire();
		ResizeObserverMock.instances[0]?.fire();

		expect(clearRect.mock.calls.length).toBe(afterInitial);
	});
});
