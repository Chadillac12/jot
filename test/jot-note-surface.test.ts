/* @vitest-environment happy-dom */
/* eslint-disable
	obsidianmd/prefer-active-doc,
	obsidianmd/no-global-this,
	@typescript-eslint/no-explicit-any,
	@typescript-eslint/no-unsafe-member-access,
	@typescript-eslint/no-unnecessary-type-assertion,
	@typescript-eslint/no-unsafe-argument
*/
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { documentPageKey } from '../src/jot-file';
import { createJotNote, createJotPage } from '../src/jot-note-file';
import { JotNoteSurface } from '../src/jot-note-surface';
import { StrokeStore } from '../src/stroke-store';

class ResizeObserverMock {
	static instances: ResizeObserverMock[] = [];

	constructor(private callback: ResizeObserverCallback) {
		ResizeObserverMock.instances.push(this);
	}
	observe(): void {
		this.callback([], this as unknown as ResizeObserver);
	}
	disconnect(): void {}
	unobserve(): void {}
	fire(): void {
		this.callback([], this as unknown as ResizeObserver);
	}
}

beforeEach(() => {
	document.body.innerHTML = '';
	ResizeObserverMock.instances = [];
	(globalThis as any).ResizeObserver = ResizeObserverMock;
	(globalThis as any).window.devicePixelRatio = 2;
	Object.defineProperty(window, 'IntersectionObserver', {
		value: undefined,
		configurable: true,
		writable: true,
	});
	(HTMLElement.prototype as any).setCssStyles = function (styles: Record<string, string>) {
		for (const [key, value] of Object.entries(styles)) {
			if (key.startsWith('--')) {
				(this as HTMLElement).style.setProperty(key, value);
			} else {
				Object.assign((this as HTMLElement).style, { [key]: value });
			}
		}
	};
	vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
		x: 0,
		y: 0,
		left: 0,
		top: 0,
		right: 768,
		bottom: 1024,
		width: 768,
		height: 1024,
		toJSON: () => ({}),
	});
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
		setTransform: vi.fn(),
		clearRect: vi.fn(),
	} as any);
	window.requestAnimationFrame = (callback: FrameRequestCallback) => {
		callback(0);
		return 1;
	};
	window.cancelAnimationFrame = vi.fn();
});

describe('JotNoteSurface', () => {
	it('retries notebook ink wiring if WebKit temporarily cannot initialize input', async () => {
		vi.useFakeTimers();
		try {
			const host = document.createElement('div');
			document.body.appendChild(host);
			let attempts = 0;
			const wire = vi.fn((): (() => void) | null => {
				attempts += 1;
				return attempts === 1 ? null : () => {};
			});
			const surface = new JotNoteSurface(host, new StrokeStore(), wire);
			surface.render(createJotNote(), 'Lecture.jot');
			expect(wire).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(500);
			expect(wire).toHaveBeenCalledTimes(2);
			expect(host.querySelector('canvas.jot-note-live-ink')).not.toBeNull();
			surface.disconnect();
		} finally {
			vi.useRealTimers();
		}
	});

	it('renders one persistent and one live Ink Engine layer per page', () => {
		const host = document.createElement('div');
		document.body.appendChild(host);
		const wire = vi.fn();
		const surface = new JotNoteSurface(host, new StrokeStore(), wire);

		surface.render(createJotNote(), 'School/Lecture.jot');

		const persistent = host.querySelectorAll<HTMLCanvasElement>('canvas.jot-note-ink');
		const live = host.querySelectorAll<HTMLCanvasElement>('canvas.jot-note-live-ink');
		expect(persistent).toHaveLength(1);
		expect(live).toHaveLength(1);
		expect(wire).toHaveBeenCalledTimes(1);
		expect(persistent[0]?.getAttribute('data-jot-key')).toBe(
			documentPageKey('School/Lecture.jot', 'page-1'),
		);
		expect(live[0]?.getAttribute('data-jot-key')).toBe(
			documentPageKey('School/Lecture.jot', 'page-1'),
		);
	});

	it('stores an explicit width-derived page height ratio for iPad layout', () => {
		const host = document.createElement('div');
		const surface = new JotNoteSurface(host, new StrokeStore(), vi.fn());

		surface.render(createJotNote(), 'Lecture.jot');

		const sheet = host.querySelector<HTMLElement>('.jot-note-sheet');
		expect(sheet?.style.getPropertyValue('--jot-page-height-ratio')).toBe(
			((2048 / 1536) * 100).toString() + '%',
		);
		expect(sheet?.style.aspectRatio).toBe('');
	});

	it('renders paper as a dedicated layer below both ink canvases', () => {
		const host = document.createElement('div');
		const surface = new JotNoteSurface(host, new StrokeStore(), vi.fn());

		surface.render(createJotNote(), 'Lecture.jot');

		const sheet = host.querySelector<HTMLElement>('.jot-note-sheet');
		expect(sheet?.children[0]?.classList.contains('jot-note-paper')).toBe(true);
		expect(sheet?.children[1]?.classList.contains('jot-note-ink')).toBe(true);
		expect(sheet?.children[2]?.classList.contains('jot-note-live-ink')).toBe(true);
		expect(sheet?.querySelector('.jot-note-paper-ruled')).not.toBeNull();
	});

	it('keeps paper guide spacing tied to normalized page dimensions', () => {
		const host = document.createElement('div');
		const surface = new JotNoteSurface(host, new StrokeStore(), vi.fn());

		surface.render(createJotNote(), 'Lecture.jot');

		const paper = host.querySelector<HTMLElement>('.jot-note-paper');
		expect(paper?.style.getPropertyValue('--jot-paper-x')).toBe(
			((64 / 1536) * 100).toString() + '%',
		);
		expect(paper?.style.getPropertyValue('--jot-paper-y')).toBe(
			((64 / 2048) * 100).toString() + '%',
		);
	});

	it('changes paper style without rebuilding or rewiring canvases', () => {
		const host = document.createElement('div');
		const wire = vi.fn();
		const surface = new JotNoteSurface(host, new StrokeStore(), wire);

		surface.render(createJotNote(), 'Lecture.jot');
		const liveBefore = host.querySelector<HTMLCanvasElement>('canvas.jot-note-live-ink');
		expect(wire).toHaveBeenCalledTimes(1);

		surface.setPaperStyle('grid');

		expect(host.querySelector('.jot-note-paper')?.classList.contains('jot-note-paper-grid')).toBe(true);
		expect(host.querySelector<HTMLCanvasElement>('canvas.jot-note-live-ink')).toBe(liveBefore);
		expect(wire).toHaveBeenCalledTimes(1);
	});

	it('renders additional pages with unique ink keys', () => {
		const host = document.createElement('div');
		const note = createJotNote();
		note.pages.push(createJotPage('page-2'));
		const wire = vi.fn();
		const surface = new JotNoteSurface(host, new StrokeStore(), wire);

		surface.render(note, 'Lecture.jot');

		const live = Array.from(host.querySelectorAll<HTMLCanvasElement>('canvas.jot-note-live-ink'));
		expect(live).toHaveLength(2);
		expect(wire).toHaveBeenCalledTimes(2);
		expect(live.map((canvas) => canvas.getAttribute('data-jot-key'))).toEqual([
			'Lecture.jot::page-1',
			'Lecture.jot::page-2',
		]);
	});

	it('does not reallocate or repaint canvases when ResizeObserver reports the same size', () => {
		const host = document.createElement('div');
		const clearRect = vi.fn();
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
			setTransform: vi.fn(),
			clearRect,
		} as any);
		const surface = new JotNoteSurface(host, new StrokeStore(), vi.fn());

		surface.render(createJotNote(), 'Lecture.jot');
		const afterInitialRender = clearRect.mock.calls.length;
		ResizeObserverMock.instances[0]?.fire();

		expect(clearRect.mock.calls.length).toBe(afterInitialRender);
	});

	it('mounts canvases only for pages near the viewport and disposes them when they leave', () => {
		let callback: IntersectionObserverCallback = () => {};
		const observe = vi.fn();
		const disconnect = vi.fn();
		class IntersectionObserverMock {
			constructor(cb: IntersectionObserverCallback) {
				callback = cb;
			}
			observe = observe;
			unobserve = vi.fn();
			disconnect = disconnect;
			takeRecords = vi.fn(() => []);
			root = null;
			rootMargin = '100% 0px 100% 0px';
			thresholds = [0];
		}
		Object.defineProperty(window, 'IntersectionObserver', {
			value: IntersectionObserverMock,
			configurable: true,
			writable: true,
		});

		const host = document.createElement('div');
		document.body.appendChild(host);
		const note = createJotNote();
		note.pages.push(createJotPage('page-2'));
		note.pages.push(createJotPage('page-3'));
		const disposers: ReturnType<typeof vi.fn>[] = [];
		const wire = vi.fn(() => {
			const dispose = vi.fn();
			disposers.push(dispose);
			return dispose;
		});
		const surface = new JotNoteSurface(host, new StrokeStore(), wire);

		surface.render(note, 'Lecture.jot');

		const sheets = Array.from(host.querySelectorAll<HTMLElement>('.jot-note-sheet'));
		expect(observe).toHaveBeenCalledTimes(3);
		expect(host.querySelectorAll('canvas')).toHaveLength(4);

		callback(
			[
				{
					target: sheets[1]!,
					isIntersecting: true,
					intersectionRatio: 1,
				} as unknown as IntersectionObserverEntry,
			],
			{} as IntersectionObserver,
		);
		expect(host.querySelectorAll('canvas')).toHaveLength(5);

		callback(
			[
				{
					target: sheets[0]!,
					isIntersecting: false,
					intersectionRatio: 0,
				} as unknown as IntersectionObserverEntry,
			],
			{} as IntersectionObserver,
		);
		expect(host.querySelectorAll('canvas')).toHaveLength(5);
		expect(disposers[0]).not.toHaveBeenCalled();

		surface.disconnect();
		expect(disposers[0]).toHaveBeenCalledTimes(1);
		expect(host.querySelectorAll('canvas')).toHaveLength(0);
		expect(disconnect).toHaveBeenCalledTimes(1);
	});

	it('can keep a hybrid page unmounted until it intersects and enforce a smaller zoom budget', () => {
		let callback: IntersectionObserverCallback = () => {};
		const observe = vi.fn();
		const disconnect = vi.fn();
		class IntersectionObserverMock {
			constructor(cb: IntersectionObserverCallback) {
				callback = cb;
			}
			observe = observe;
			unobserve = vi.fn();
			disconnect = disconnect;
			takeRecords = vi.fn(() => []);
			root = null;
			rootMargin = '50% 0px 50% 0px';
			thresholds = [0];
		}
		Object.defineProperty(window, 'IntersectionObserver', {
			value: IntersectionObserverMock,
			configurable: true,
			writable: true,
		});

		const viewport = document.createElement('div');
		const host = document.createElement('div');
		viewport.appendChild(host);
		document.body.appendChild(viewport);
		const wire = vi.fn(() => vi.fn());
		const surface = new JotNoteSurface(host, new StrokeStore(), wire, {
			observerRoot: viewport,
			eagerMountFirstPage: false,
			rootMargin: '50% 0px 50% 0px',
			backingStoreLimits: {
				maxDimension: 2048,
				maxArea: 2_500_000,
			},
			fixedLogicalBackingStore: true,
		});

		surface.render(createJotNote(), 'notes.pdf');
		const sheet = host.querySelector<HTMLElement>('.jot-note-sheet')!;
		sheet.getBoundingClientRect = () =>
			({
				x: 0,
				y: 0,
				left: 0,
				top: 0,
				right: 2400,
				bottom: 3200,
				width: 2400,
				height: 3200,
				toJSON: () => ({}),
			});

		expect(observe).toHaveBeenCalledTimes(1);
		expect(host.querySelectorAll('canvas')).toHaveLength(1);
		expect(wire).toHaveBeenCalledTimes(0);

		callback(
			[
				{
					target: sheet,
					isIntersecting: true,
					intersectionRatio: 1,
				} as unknown as IntersectionObserverEntry,
			],
			{} as IntersectionObserver,
		);

		expect(wire).toHaveBeenCalledTimes(1);
		const canvases = Array.from(host.querySelectorAll<HTMLCanvasElement>('canvas'));
		expect(canvases).toHaveLength(2);
		expect(wire).toHaveBeenCalledTimes(1);
		for (const canvas of canvases) {
			expect(canvas.width * canvas.height).toBeLessThanOrEqual(2_500_000);
		}
		expect(ResizeObserverMock.instances).toHaveLength(0);

		const initialSizes = canvases.map((canvas) => [canvas.width, canvas.height]);
		sheet.getBoundingClientRect = () =>
			({
				x: 0,
				y: 0,
				left: 0,
				top: 0,
				right: 600,
				bottom: 800,
				width: 600,
				height: 800,
				toJSON: () => ({}),
			});
		expect(
			Array.from(host.querySelectorAll<HTMLCanvasElement>('canvas')).map((canvas) => [
				canvas.width,
				canvas.height,
			]),
		).toEqual(initialSizes);

		callback(
			[
				{
					target: sheet,
					isIntersecting: false,
					intersectionRatio: 0,
				} as unknown as IntersectionObserverEntry,
			],
			{} as IntersectionObserver,
		);
		expect(host.querySelectorAll('canvas')).toHaveLength(2);
		surface.disconnect();
		expect(host.querySelectorAll('canvas')).toHaveLength(0);
	});

	it('retains a hybrid Pencil target through zoom jitter and reactivates on pen-down', async () => {
		vi.useFakeTimers();
		try {
			let callback: IntersectionObserverCallback = () => {};
			class Observer {
				constructor(cb: IntersectionObserverCallback) { callback = cb; }
				observe(): void {}
				unobserve(): void {}
				disconnect(): void {}
			}
			Object.defineProperty(window, 'IntersectionObserver', {
				value: Observer,
				configurable: true,
				writable: true,
			});
			const host = document.createElement('div');
			document.body.appendChild(host);
			const wire = vi.fn(() => vi.fn());
			const surface = new JotNoteSurface(host, new StrokeStore(), wire, {
				observerRoot: document.body,
				eagerMountFirstPage: false,
				fixedLogicalBackingStore: true,
				deactivationGraceMs: 750,
			});
			surface.render(createJotNote(), 'hybrid.pdf');
			const sheet = host.querySelector<HTMLElement>('.jot-note-sheet')!;
			const live = host.querySelector<HTMLCanvasElement>('canvas.jot-note-live-ink')!;
			expect(live.width).toBe(1);
			expect(wire).toHaveBeenCalledTimes(0);
			const intersection = (isIntersecting: boolean) => callback(
				[{ target: sheet, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0 } as unknown as IntersectionObserverEntry],
				{} as IntersectionObserver,
			);
			intersection(true);
			expect(wire).toHaveBeenCalledTimes(1);
			expect(host.querySelectorAll('canvas.jot-note-ink')).toHaveLength(1);
			intersection(false);
			await vi.advanceTimersByTimeAsync(749);
			expect(host.querySelectorAll('canvas.jot-note-ink')).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(host.querySelectorAll('canvas.jot-note-ink')).toHaveLength(0);
			expect(live.isConnected).toBe(true);
			expect(live.width).toBe(1);
			live.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 4, pointerType: 'pen', bubbles: true }));
			expect(host.querySelectorAll('canvas.jot-note-ink')).toHaveLength(1);
			live.dispatchEvent(new PointerEvent('pointerup', { pointerId: 4, pointerType: 'pen', bubbles: true }));
			await vi.advanceTimersByTimeAsync(750);
			expect(host.querySelectorAll('canvas.jot-note-ink')).toHaveLength(0);
			expect(live.isConnected).toBe(true);
			expect(wire).toHaveBeenCalledTimes(2);
			surface.disconnect();
			expect(live.isConnected).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it('sizes the live canvas before the very first Pencil event even when rAF is delayed', () => {
		const frames: FrameRequestCallback[] = [];
		window.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
		const host = document.createElement('div');
		document.body.appendChild(host);
		const surface = new JotNoteSurface(host, new StrokeStore(), vi.fn(() => vi.fn()));
		surface.render(createJotNote(), 'Delayed.jot');
		const live = host.querySelector<HTMLCanvasElement>('canvas.jot-note-live-ink')!;
		expect(live.width).toBe(1);
		live.dispatchEvent(new PointerEvent('pointerdown', {
			pointerType: 'pen', pointerId: 23, bubbles: true,
		}));
		expect(live.width).toBeGreaterThan(1);
		expect(live.height).toBeGreaterThan(1);
		expect(host.querySelector<HTMLCanvasElement>('canvas.jot-note-ink')?.width).toBeGreaterThan(1);
		surface.disconnect();
	});

	it('ignores stale pointer-end events that belong to an older Pencil gesture', async () => {
		vi.useFakeTimers();
		try {
			const host = document.createElement('div');
			document.body.appendChild(host);
			const surface = new JotNoteSurface(host, new StrokeStore(), vi.fn(() => vi.fn()));
			surface.render(createJotNote(), 'Pointer.jot');
			const live = host.querySelector<HTMLCanvasElement>('canvas.jot-note-live-ink')!;
			const emit = (type: string, pointerId: number) => live.dispatchEvent(
				new PointerEvent(type, { pointerType: 'pen', pointerId, bubbles: true }),
			);
			emit('pointerdown', 11);
			emit('pointerdown', 12);
			emit('lostpointercapture', 11);
			await vi.advanceTimersByTimeAsync(900);
			expect(host.querySelectorAll('canvas.jot-note-ink')).toHaveLength(1);
			emit('pointerup', 12);
			await vi.advanceTimersByTimeAsync(750);
			expect(host.querySelectorAll('canvas.jot-note-ink')).toHaveLength(0);
			surface.disconnect();
		} finally {
			vi.useRealTimers();
		}
	});

	it('retains hundreds of cheap notebook hit targets without preallocating 2D contexts', () => {
		class Observer {
			constructor(private cb: IntersectionObserverCallback) {}
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		}
		Object.defineProperty(window, 'IntersectionObserver', {
			value: Observer, configurable: true, writable: true,
		});
		const host = document.createElement('div');
		document.body.appendChild(host);
		const note = createJotNote();
		note.pages = Array.from({ length: 120 }, (_, i) => createJotPage(`page-${i + 1}`));
		const contexts = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
		contexts.mockClear();
		const wire = vi.fn(() => vi.fn());
		const surface = new JotNoteSurface(host, new StrokeStore(), wire, {
			eagerMountFirstPage: false, observerRoot: document.body,
		});
		surface.render(note, 'Long.jot');
		expect(host.querySelectorAll('canvas.jot-note-live-ink')).toHaveLength(120);
		expect(host.querySelectorAll('canvas.jot-note-ink')).toHaveLength(0);
		expect(wire).not.toHaveBeenCalled();
		expect(contexts).not.toHaveBeenCalled();
		surface.disconnect();
	});

	it('bounds WebKit context-allocation retries under sustained resource failure', async () => {
		vi.useFakeTimers();
		try {
			let callback: IntersectionObserverCallback = () => {};
			class Observer {
				constructor(cb: IntersectionObserverCallback) { callback = cb; }
				observe(): void {}
				unobserve(): void {}
				disconnect(): void {}
			}
			Object.defineProperty(window, 'IntersectionObserver', {
				value: Observer, configurable: true, writable: true,
			});
			const failedContexts = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
			const host = document.createElement('div');
			document.body.appendChild(host);
			const surface = new JotNoteSurface(host, new StrokeStore(), vi.fn(), {
				eagerMountFirstPage: false, observerRoot: document.body,
			});
			surface.render(createJotNote(), 'Unavailable.jot');
			const sheet = host.querySelector<HTMLElement>('.jot-note-sheet')!;
			callback([{ target: sheet, isIntersecting: true, intersectionRatio: 1 } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
			await vi.advanceTimersByTimeAsync(60000);
			const attempts = failedContexts.mock.calls.length;
			expect(attempts).toBeGreaterThan(0);
			// Each bounded attempt may probe both input and persistent contexts.
			expect(attempts).toBeLessThanOrEqual(25);
			expect(vi.getTimerCount()).toBe(0);
			expect(host.querySelector('.jot-note-canvas-error')).not.toBeNull();
			surface.disconnect();
		} finally {
			vi.useRealTimers();
		}
	});

	it('recovers missing hybrid Jot live canvas from the sheet and forwards first Pencil gesture', () => {
		class NoIntersectionMock {
			observe(): void {}
			disconnect(): void {}
			unobserve(): void {}
		}
		Object.defineProperty(window, 'IntersectionObserver', {
			value: NoIntersectionMock, configurable: true, writable: true,
		});
		const host = document.createElement('div');
		document.body.appendChild(host);
		const forwarded: string[] = [];
		const wire = vi.fn((_canvas: HTMLCanvasElement, register?: (forwarder: ((event: PointerEvent) => void) | null) => void) => {
			register?.((event) => forwarded.push(event.type));
			return () => register?.(null);
		});
		const surface = new JotNoteSurface(host, new StrokeStore(), wire, {
			eagerMountFirstPage: false,
			observerRoot: document.body,
			fixedLogicalBackingStore: true,
		});
		surface.render(createJotNote(), 'hybrid.pdf');
		const sheet = host.querySelector<HTMLElement>('.jot-note-sheet')!;
		const live = sheet.querySelector('canvas.jot-note-live-ink');
		expect(wire).not.toHaveBeenCalled();
		live?.remove();
		sheet.dispatchEvent(new PointerEvent('pointerdown', {
			bubbles: true, pointerId: 51, pointerType: 'pen',
		}));
		sheet.dispatchEvent(new PointerEvent('pointermove', {
			bubbles: true, pointerId: 51, pointerType: 'pen',
		}));
		sheet.dispatchEvent(new PointerEvent('pointerup', {
			bubbles: true, pointerId: 51, pointerType: 'pen',
		}));
		expect(forwarded).toEqual(['pointerdown', 'pointermove', 'pointerup']);
		expect(sheet.querySelector('canvas.jot-note-live-ink')).not.toBeNull();
		expect(sheet.querySelector('canvas.jot-note-ink')).not.toBeNull();
		expect(wire).toHaveBeenCalledTimes(1);
		surface.disconnect();
	});

	it('caps both notebook canvas backing stores at the iPad-safe area', () => {
		const host = document.createElement('div');
		const surface = new JotNoteSurface(host, new StrokeStore(), vi.fn());

		surface.render(createJotNote(), 'Lecture.jot');

		for (const canvas of Array.from(host.querySelectorAll<HTMLCanvasElement>('canvas'))) {
			expect(canvas.width * canvas.height).toBeLessThanOrEqual(16_777_216);
		}
	});
});
