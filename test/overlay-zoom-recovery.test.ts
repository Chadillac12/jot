/* @vitest-environment happy-dom */
/* eslint-disable
	obsidianmd/prefer-active-doc,
	obsidianmd/no-global-this,
	@typescript-eslint/no-explicit-any,
	@typescript-eslint/no-unsafe-argument,
	@typescript-eslint/no-unsafe-member-access,
	@typescript-eslint/no-unnecessary-type-assertion
*/
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OverlayManager, OVERLAY_KEY_ATTR } from '../src/overlay-manager';
import { PdfInsertedPageStore } from '../src/pdf-inserted-page-store';
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
		});
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
	const disposeInput = vi.fn();
	const wire = vi.fn(() => disposeInput);
	const manager = new OverlayManager(app as any, new StrokeStore(), wire);
	return { page, manager, wire, disposeInput };
}

beforeEach(() => {
	document.body.innerHTML = '';
	ResizeObserverMock.instances = [];
	(globalThis as any).activeDocument = document;
	(globalThis as any).ResizeObserver = ResizeObserverMock;
	(globalThis as any).window.devicePixelRatio = 2;
	Object.defineProperty(window, 'IntersectionObserver', {
		value: undefined,
		configurable: true,
		writable: true,
	});
	window.requestAnimationFrame = (callback: FrameRequestCallback) => {
		callback(0);
		return 1;
	};
	window.cancelAnimationFrame = vi.fn();
	(HTMLElement.prototype as any).setCssStyles = function (styles: Record<string, string>) {
		Object.assign((this as HTMLElement).style, styles);
	};
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
		setTransform: vi.fn(),
		clearRect: vi.fn(),
	} as any);
});

describe('OverlayManager zoom recovery', () => {
	it('does zero hybrid reconciliation during ordinary PDF zoom mutations', async () => {
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
				file: { path: 'plain.pdf' },
				getViewType: () => 'pdf',
			},
		};
		const app = {
			workspace: {
				getMostRecentLeaf: () => leaf,
				iterateAllLeaves: (fn: (value: unknown) => void) => fn(leaf),
			},
		};
		const layout = new PdfInsertedPageStore();
		const all = vi.spyOn(layout, 'all');
		const manager = new OverlayManager(
			app as any,
			new StrokeStore(),
			vi.fn(() => vi.fn()),
			layout,
			{ onInsertedPagePaperChange: vi.fn() },
		);

		manager.attachToActivePdf();
		expect(all).not.toHaveBeenCalled();

		const pdfJsReplacement = document.createElement('span');
		page.appendChild(pdfJsReplacement);
		await flushMutations();

		expect(all).not.toHaveBeenCalled();
		expect(page.querySelectorAll('canvas.jot-overlay')).toHaveLength(1);
		expect(page.querySelectorAll('canvas.jot-live-overlay')).toHaveLength(1);
	});

	it('defers hybrid reconciliation only when PDF page topology changes', async () => {
		vi.useFakeTimers();
		try {
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
					file: { path: 'hybrid.pdf' },
					getViewType: () => 'pdf',
				},
			};
			const app = {
				workspace: {
					getMostRecentLeaf: () => leaf,
					iterateAllLeaves: (fn: (value: unknown) => void) => fn(leaf),
				},
			};
			const layout = new PdfInsertedPageStore();
			layout.add('hybrid.pdf', 1, 'grid');
			const all = vi.spyOn(layout, 'all');
			const manager = new OverlayManager(
				app as any,
				new StrokeStore(),
				vi.fn(() => vi.fn()),
				layout,
				{ onInsertedPagePaperChange: vi.fn() },
			);

			manager.attachToActivePdf();
			expect(all).toHaveBeenCalledTimes(1);

			// Descendant churn inside an existing page is zoom/render noise and
			// must not schedule a whole-document hybrid reconciliation.
			page.appendChild(document.createElement('span'));
			await flushMutations();
			await vi.advanceTimersByTimeAsync(300);
			expect(all).toHaveBeenCalledTimes(1);

			// A real source-page topology change does require deferred repair.
			const page2 = document.createElement('div');
			page2.className = 'page';
			page2.setAttribute('data-page-number', '2');
			setRect(page2, 800, 1000);
			container.appendChild(page2);
			await flushMutations();

			expect(all).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(299);
			expect(all).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(all).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('releases a detached live backing store and recovers only after the mutation burst settles', async () => {
		vi.useFakeTimers();
		try {
			const { page, manager, wire } = makeHarness();
			manager.attachToActivePdf();
			const persistent = page.querySelector<HTMLCanvasElement>('canvas.jot-overlay');
			const firstLive = page.querySelector<HTMLCanvasElement>('canvas.jot-live-overlay');
			expect(persistent).not.toBeNull();
			expect(firstLive).not.toBeNull();
			expect(wire).toHaveBeenCalledTimes(1);

			firstLive?.remove();
			await flushMutations();

			expect(firstLive?.width).toBe(1);
			expect(firstLive?.height).toBe(1);
			expect(page.querySelector('canvas.jot-live-overlay')).toBeNull();
			expect(wire).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(100);
			page.appendChild(document.createElement('div'));
			await flushMutations();

			// The recovery delay restarts after additional PDF.js child churn.
			await vi.advanceTimersByTimeAsync(149);
			expect(page.querySelector('canvas.jot-live-overlay')).toBeNull();

			await vi.advanceTimersByTimeAsync(1);
			const replacement = page.querySelector<HTMLCanvasElement>('canvas.jot-live-overlay');
			expect(replacement).not.toBeNull();
			expect(replacement).not.toBe(firstLive);
			expect(replacement?.getAttribute(OVERLAY_KEY_ATTR)).toBe('notes.pdf::1');
			expect(wire).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('releases a detached persistent backing store and recovers without duplicating the live handler', async () => {
		vi.useFakeTimers();
		try {
			const { page, manager, wire } = makeHarness();
			manager.attachToActivePdf();
			const first = page.querySelector<HTMLCanvasElement>('canvas.jot-overlay');
			expect(first).not.toBeNull();

			first?.remove();
			await flushMutations();

			expect(first?.width).toBe(1);
			expect(first?.height).toBe(1);
			expect(page.querySelectorAll('canvas.jot-overlay')).toHaveLength(0);
			expect(page.querySelectorAll('canvas.jot-live-overlay')).toHaveLength(1);
			expect(wire).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(150);

			expect(page.querySelectorAll('canvas.jot-overlay')).toHaveLength(1);
			expect(page.querySelectorAll('canvas.jot-live-overlay')).toHaveLength(1);
			expect(wire).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('disposes page observers, canvases, and input handlers on disconnect', () => {
		const { page, manager, disposeInput } = makeHarness();
		manager.attachToActivePdf();
		expect(page.querySelector('canvas.jot-live-overlay')).not.toBeNull();

		manager.disconnectAll();

		expect(disposeInput).toHaveBeenCalledTimes(1);
		expect(page.querySelector('canvas.jot-live-overlay')).toBeNull();
		expect(page.querySelector('canvas.jot-overlay')).toBeNull();
		expect(page.classList.contains('jot-page-anchor')).toBe(false);
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
			expect((canvas?.width ?? 0) * (canvas?.height ?? 0)).toBeLessThanOrEqual(2_500_000);
		}
	});

	it('keeps lightweight Pencil hit targets on all PDF pages while virtualizing heavy backing stores', async () => {
		vi.useFakeTimers();
		try {
			type EntryCallback = IntersectionObserverCallback;
			class IntersectionObserverVirtualizationMock {
				static instances: IntersectionObserverVirtualizationMock[] = [];
				target: Element | null = null;
				constructor(private callback: EntryCallback) {
					IntersectionObserverVirtualizationMock.instances.push(this);
				}
				observe(target: Element): void {
					this.target = target;
				}
				unobserve(): void {}
				disconnect(): void {}
				takeRecords(): IntersectionObserverEntry[] {
					return [];
				}
				root = null;
				rootMargin = '75% 0px 75% 0px';
				thresholds = [0];
				fire(isIntersecting: boolean): void {
					if (!this.target) return;
					this.callback(
						[
							{
								target: this.target,
								isIntersecting,
								intersectionRatio: isIntersecting ? 1 : 0,
							} as IntersectionObserverEntry,
						],
						this as unknown as IntersectionObserver,
					);
				}
			}
			Object.defineProperty(window, 'IntersectionObserver', {
				value: IntersectionObserverVirtualizationMock,
				configurable: true,
				writable: true,
			});

			const container = document.createElement('div');
			for (let i = 1; i <= 53; i++) {
				const page = document.createElement('div');
				page.className = 'page';
				page.setAttribute('data-page-number', String(i));
				setRect(page, 1200, 900);
				container.appendChild(page);
			}
			document.body.appendChild(container);

			const leaf = {
				view: {
					containerEl: container,
					file: { path: 'long.pdf' },
					getViewType: () => 'pdf',
				},
			};
			const app = {
				workspace: {
					getMostRecentLeaf: () => leaf,
					iterateAllLeaves: (fn: (value: unknown) => void) => fn(leaf),
				},
			};
			const wire = vi.fn(() => vi.fn());
			const manager = new OverlayManager(app as any, new StrokeStore(), wire);

			manager.attachToActivePdf();

			expect(IntersectionObserverVirtualizationMock.instances).toHaveLength(53);
			expect(container.querySelectorAll('canvas.jot-overlay')).toHaveLength(0);
			expect(container.querySelectorAll('canvas.jot-live-overlay')).toHaveLength(53);
			expect(wire).toHaveBeenCalledTimes(0);
			for (const canvas of Array.from(
				container.querySelectorAll<HTMLCanvasElement>('canvas.jot-live-overlay'),
			)) {
				expect(canvas.width).toBe(1);
				expect(canvas.height).toBe(1);
				expect(canvas.classList.contains('jot-live-overlay-dormant')).toBe(true);
			}

			IntersectionObserverVirtualizationMock.instances[1]?.fire(true);
			IntersectionObserverVirtualizationMock.instances[2]?.fire(true);
			IntersectionObserverVirtualizationMock.instances[3]?.fire(true);
			expect(wire).toHaveBeenCalledTimes(3);
			expect(container.querySelectorAll('canvas.jot-overlay')).toHaveLength(3);
			expect(container.querySelectorAll('canvas.jot-live-overlay')).toHaveLength(53);

			const secondPage = container.querySelector<HTMLElement>('[data-page-number="2"]')!;
			const activePersistent = secondPage.querySelector<HTMLCanvasElement>('canvas.jot-overlay');
			const activeLive = secondPage.querySelector<HTMLCanvasElement>('canvas.jot-live-overlay');
			expect((activePersistent?.width ?? 0) * (activePersistent?.height ?? 0)).toBeLessThanOrEqual(
				2_500_000,
			);
			expect((activeLive?.width ?? 0) * (activeLive?.height ?? 0)).toBeLessThanOrEqual(
				2_500_000,
			);
			expect(activeLive?.width).toBeGreaterThan(1);

			// A transient false intersection during zoom must not immediately
			// remove the rendering surface.
			IntersectionObserverVirtualizationMock.instances[1]?.fire(false);
			await vi.advanceTimersByTimeAsync(749);
			expect(secondPage.querySelector('canvas.jot-overlay')).not.toBeNull();

			await vi.advanceTimersByTimeAsync(1);
			expect(activePersistent?.width).toBe(1);
			expect(activePersistent?.height).toBe(1);
			expect(secondPage.querySelector('canvas.jot-overlay')).toBeNull();
			expect(activeLive?.width).toBe(1);
			expect(activeLive?.height).toBe(1);
			expect(activeLive?.isConnected).toBe(true);
			expect(activeLive?.style.width).toBe('');
			expect(activeLive?.style.height).toBe('');

			// Even when IntersectionObserver still considers the page outside,
			// Pencil-down on the dormant 1x1 hit target promotes it before the
			// normal PointerEventHandler runs.
			const penDown = new PointerEvent('pointerdown', {
				pointerId: 77,
				pointerType: 'pen',
				clientX: 20,
				clientY: 20,
				bubbles: true,
			});
			activeLive?.dispatchEvent(penDown);
			expect(secondPage.querySelector('canvas.jot-overlay')).not.toBeNull();
			expect(activeLive?.width).toBeGreaterThan(1);
			expect(activeLive?.height).toBeGreaterThan(1);

			activeLive?.dispatchEvent(
				new PointerEvent('pointerup', {
					pointerId: 77,
					pointerType: 'pen',
					clientX: 20,
					clientY: 20,
					bubbles: true,
				}),
			);
			await vi.advanceTimersByTimeAsync(750);
			expect(secondPage.querySelector('canvas.jot-overlay')).toBeNull();
			expect(activeLive?.width).toBe(1);
			expect(activeLive?.height).toBe(1);
			expect(activeLive?.isConnected).toBe(true);

			// A late lostcapture from an earlier pointer must not release the
			// current gesture's pin and unmount the real drawing backing store.
			activeLive?.dispatchEvent(penDown);
			activeLive?.dispatchEvent(new PointerEvent('pointerdown', {
				pointerId: 78, pointerType: 'pen', bubbles: true,
			}));
			activeLive?.dispatchEvent(new PointerEvent('lostpointercapture', {
				pointerId: 77, pointerType: 'pen', bubbles: true,
			}));
			await vi.advanceTimersByTimeAsync(900);
			expect(secondPage.querySelector('canvas.jot-overlay')).not.toBeNull();
			activeLive?.dispatchEvent(new PointerEvent('pointerup', {
				pointerId: 78, pointerType: 'pen', bubbles: true,
			}));
			await vi.advanceTimersByTimeAsync(750);
			expect(secondPage.querySelector('canvas.jot-overlay')).toBeNull();

			// Losing the original live canvas during an active gesture must not
			// strand pointer ownership and keep its heavy buffer alive forever.
			activeLive?.dispatchEvent(penDown);
			activeLive?.remove();
			await flushMutations();
			await vi.advanceTimersByTimeAsync(150);
			await vi.advanceTimersByTimeAsync(750);
			expect(secondPage.querySelector('canvas.jot-overlay')).toBeNull();
			expect(secondPage.querySelector('canvas.jot-live-overlay')).not.toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});


	it('rebinds inserted page ink keys when the owning PDF path changes', () => {
		const container = document.createElement('div');
		const page = document.createElement('div');
		page.className = 'page';
		page.setAttribute('data-page-number', '1');
		setRect(page, 800, 1000);
		container.appendChild(page);
		document.body.appendChild(container);

		const view = {
			containerEl: container,
			file: { path: 'Old/notes.pdf' },
			getViewType: () => 'pdf',
		};
		const leaf = { view };
		const app = {
			workspace: {
				getMostRecentLeaf: () => leaf,
				iterateAllLeaves: (fn: (value: unknown) => void) => fn(leaf),
			},
		};
		const layout = new PdfInsertedPageStore();
		const inserted = layout.add('Old/notes.pdf', 1, 'ruled');
		const manager = new OverlayManager(
			app as any,
			new StrokeStore(),
			vi.fn(() => vi.fn()),
			layout,
			{ onInsertedPagePaperChange: vi.fn() },
		);

		manager.attachToActivePdf();
		expect(
			container
				.querySelector<HTMLCanvasElement>('.jot-pdf-inserted-page canvas.jot-note-ink')
				?.getAttribute(OVERLAY_KEY_ATTR),
		).toBe(`Old/notes.pdf::jot:${inserted.id}`);

		layout.rekeyDocumentPath('Old/notes.pdf', 'New/notes.pdf');
		view.file.path = 'New/notes.pdf';
		manager.refreshPdf('New/notes.pdf');

		expect(container.querySelectorAll('.jot-pdf-inserted-page')).toHaveLength(1);
		expect(
			container
				.querySelector<HTMLCanvasElement>('.jot-pdf-inserted-page canvas.jot-note-ink')
				?.getAttribute(OVERLAY_KEY_ATTR),
		).toBe(`New/notes.pdf::jot:${inserted.id}`);
	});

	it('places an inserted Jot page between PDF pages without duplicating it on resync', () => {
		const container = document.createElement('div');
		const page1 = document.createElement('div');
		page1.className = 'page';
		page1.setAttribute('data-page-number', '1');
		setRect(page1, 800, 1000);
		const page2 = document.createElement('div');
		page2.className = 'page';
		page2.setAttribute('data-page-number', '2');
		setRect(page2, 800, 1000);
		container.append(page1, page2);
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
		const layout = new PdfInsertedPageStore();
		const inserted = layout.add('notes.pdf', 1, 'grid');
		const wire = vi.fn(() => vi.fn());
		const manager = new OverlayManager(
			app as any,
			new StrokeStore(),
			wire,
			layout,
			{ onInsertedPagePaperChange: vi.fn() },
		);

		manager.attachToActivePdf();

		const gap = container.querySelector<HTMLElement>('.jot-pdf-inserted-gap');
		const insertedRoot = container.querySelector<HTMLElement>('.jot-pdf-inserted-page');
		expect(gap).not.toBeNull();
		expect(gap?.previousSibling).toBe(page1);
		expect(gap?.nextSibling).toBe(page2);
		expect(insertedRoot?.dataset.jotInsertedPageId).toBe(inserted.id);
		expect(
			insertedRoot
				?.querySelector<HTMLCanvasElement>('canvas.jot-note-ink')
				?.getAttribute(OVERLAY_KEY_ATTR),
		).toBe(`notes.pdf::jot:${inserted.id}`);

		const wireCalls = wire.mock.calls.length;
		manager.refreshPdf('notes.pdf');

		expect(container.querySelectorAll('.jot-pdf-inserted-page')).toHaveLength(1);
		expect(wire.mock.calls.length).toBe(wireCalls);
	});

});
