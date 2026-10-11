/* eslint-disable obsidianmd/prefer-active-doc */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { OverlayManager } from '../src/overlay-manager';
import { PdfInsertedPageStore } from '../src/pdf-inserted-page-store';
import { PointerEventHandler } from '../src/pointer-event-handler';
import { StrokeStore } from '../src/stroke-store';
import type { Palette } from '../src/palette';
import type { UndoController } from '../src/undo-controller';

class ResizeObserverStub {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

function rect(width: number, height: number): DOMRect {
	return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height,
		width, height, toJSON: () => ({}) };
}

const managers: OverlayManager[] = [];
beforeEach(() => {
	vi.stubGlobal('ResizeObserver', ResizeObserverStub);
	vi.stubGlobal('IntersectionObserver', undefined);
	vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 1; });
	vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(800, 1000));
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
		setTransform: vi.fn(), clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(),
		beginPath: vi.fn(), closePath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
		quadraticCurveTo: vi.fn(), fill: vi.fn(), stroke: vi.fn(), arc: vi.fn(),
	}) as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
	for (const manager of managers.splice(0)) manager.disconnectAll();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function harness(inserted: boolean) {
	const viewer = document.createElement('div');
	const page = document.createElement('div');
	page.className = 'page';
	page.dataset.pageNumber = '1';
	viewer.appendChild(page);
	document.body.appendChild(viewer);
	const leaf = { view: { containerEl: viewer, file: { path: 'notes.pdf' }, getViewType: () => 'pdf' } };
	const app = { workspace: {
		getMostRecentLeaf: () => leaf,
		iterateAllLeaves: (fn: (value: unknown) => void) => fn(leaf),
	} } as unknown as App;
	const strokes = new StrokeStore();
	const layout = new PdfInsertedPageStore();
	const insertedPage = inserted ? layout.add('notes.pdf', 1, 'grid') : null;
	const key = insertedPage ? `notes.pdf::jot:${insertedPage.id}` : 'notes.pdf::1';
	const decisions = vi.fn();
	const save = vi.fn();
	const undo = vi.fn();
	const permission = { writable: true };
	const events: { event: string; fields: Record<string, unknown> }[] = [];
	const manager = new OverlayManager(app, strokes, (canvas, register) => {
		const handler = new PointerEventHandler(canvas, canvas.getContext('2d')!, {
			palette: { isOpen: () => false } as Palette,
			strokes, overlays: manager, sidecar: { scheduleSave: save },
			undo: { push: undo } as unknown as UndoController,
			toolState: () => ({ tool: 'pen', color: '#000000', width: 0.003 }),
			handedness: () => 'right', paletteActivation: () => 'two-finger',
			onInputDecision: decisions,
			allowInput: () => permission.writable,
		});
		handler.attach();
		register?.((event) => handler.forwardPointerEvent(event));
		return () => { register?.(null); handler.detach(); };
	}, layout, { onInsertedPagePaperChange: vi.fn() }, {
		isEnabled: () => true,
		record: (event, fields = {}) => events.push({ event, fields }),
	});
	managers.push(manager);
	manager.attachToActivePdf();
	const canvas = viewer.querySelector<HTMLCanvasElement>(inserted ? '.jot-note-live-ink' : '.jot-live-overlay')!;
	return { viewer, page, manager, strokes, key, canvas, decisions, save, undo, events, permission };
}

function emit(target: HTMLElement, type: string, pointerId: number, x = 200, y = 250): void {
	target.dispatchEvent(new PointerEvent(type, {
		pointerType: 'pen', pointerId, clientX: x, clientY: y, pressure: 0.5,
		bubbles: true, cancelable: true,
	}));
}

function draw(target: HTMLElement, id: number): void {
	for (const [type, clientX, clientY] of [
		['pointerdown', 200, 250], ['pointermove', 400, 500], ['pointerup', 600, 750],
	] as const) {
		target.dispatchEvent(new PointerEvent(type, {
			pointerType: 'pen', pointerId: id, clientX, clientY, pressure: 0.5,
			bubbles: true, cancelable: true,
		}));
	}
}

describe.each([false, true])('PDF Pencil routing (inserted=%s)', (inserted) => {
	it('commits exactly once with normal event propagation', () => {
		const h = harness(inserted);
		draw(h.canvas, 1);
		expect(h.strokes.forKey(h.key)).toHaveLength(1);
		expect(h.decisions).toHaveBeenCalledTimes(1);
		expect(h.save).toHaveBeenCalledTimes(1);
		expect(h.undo).toHaveBeenCalledTimes(1);
	});

	it('keeps writing after zoom when viewer capture prevents canvas delivery', () => {
		const h = harness(inserted);
		draw(h.canvas, 1);
		expect(h.strokes.forKey(h.key)).toHaveLength(1);
		// Reproduce the trace boundary: document capture receives the event,
		// while PDF viewer capture prevents the page/sheet/target handlers.
		for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
			h.viewer.addEventListener(type, (event) => event.stopPropagation(), true);
		}
		draw(h.canvas, 2);
		expect(h.strokes.forKey(h.key)).toHaveLength(2);
		expect(h.decisions).toHaveBeenCalledTimes(2);
		expect(h.save).toHaveBeenCalledTimes(2);
		expect(h.undo).toHaveBeenCalledTimes(2);
		// Inserted ink must never be routed to a source PDF page.
		if (inserted) expect(h.strokes.forKey('notes.pdf::1')).toHaveLength(0);
	});

	it('keeps the gesture owner when continuation targets leave the original sheet', () => {
		const h = harness(inserted);
		emit(h.canvas, 'pointerdown', 5);
		emit(h.viewer, 'pointermove', 5, 400, 500);
		emit(document.body, 'pointerup', 5, 600, 750);
		const stored = h.strokes.forKey(h.key);
		expect(stored).toHaveLength(1);
		expect(stored[0]!.points.map(({ x, y }) => [x, y])).toEqual([
			[0.25, 0.25], [0.5, 0.5], [0.75, 0.75],
		]);
		expect(h.save).toHaveBeenCalledTimes(1);
	});

	it('cancels without changing earlier ink and permits the next gesture', () => {
		const h = harness(inserted);
		draw(h.canvas, 1);
		const before = JSON.stringify(h.strokes.forKey(h.key));
		emit(h.canvas, 'pointerdown', 2);
		emit(h.canvas, 'pointermove', 2, 400, 500);
		emit(h.viewer, 'pointercancel', 2);
		expect(JSON.stringify(h.strokes.forKey(h.key))).toBe(before);
		expect(h.save).toHaveBeenCalledTimes(1);
		draw(h.canvas, 3);
		expect(h.strokes.forKey(h.key)).toHaveLength(2);
	});

	it('preserves normalized coordinates through zoom and the first replaced live canvas', () => {
		const h = harness(inserted);
		draw(h.canvas, 1);
		expect(h.strokes.forKey(h.key)).toHaveLength(1);
		h.canvas.remove();
		const target = h.viewer.querySelector<HTMLElement>(inserted ? '.jot-note-sheet' : '.page')!;
		// The input arrives before a removal observer or animation frame runs.
		vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(1600, 2000));
		draw(target, 2);
		const stored = h.strokes.forKey(h.key);
		expect(stored).toHaveLength(2);
		expect(stored[0]!.points[0]).toMatchObject({ x: 0.25, y: 0.25 });
		expect(stored[1]!.points.map(({ x, y }) => [x, y])).toEqual([
			[0.125, 0.125], [0.25, 0.25], [0.375, 0.375],
		]);
		expect(h.viewer.querySelectorAll(inserted ? '.jot-note-live-ink' : '.jot-live-overlay')).toHaveLength(1);
		expect(h.manager.overlayForKey(h.key)?.isConnected).toBe(true);
	});

	it('preserves existing ink while writes are blocked', () => {
		const h = harness(inserted);
		draw(h.canvas, 1);
		const before = JSON.stringify(h.strokes.forKey(h.key));
		h.permission.writable = false;
		draw(h.canvas, 2);
		expect(JSON.stringify(h.strokes.forKey(h.key))).toBe(before);
		expect(h.save).toHaveBeenCalledTimes(1);
		expect(h.undo).toHaveBeenCalledTimes(1);
		expect(h.decisions).toHaveBeenLastCalledWith('rejected', 'write-protected');
	});

	it('releases document routing when the PDF leaf is disposed', () => {
		const h = harness(inserted);
		emit(h.canvas, 'pointerdown', 1);
		h.manager.disconnectAll();
		emit(h.viewer, 'pointerup', 1);
		draw(h.viewer, 2);
		expect(h.strokes.forKey(h.key)).toHaveLength(0);
		expect(h.save).not.toHaveBeenCalled();
	});

	it('does not route toolbar contacts or finger gestures into ink', () => {
		const h = harness(inserted);
		const control = document.createElement('select');
		h.viewer.appendChild(control);
		draw(control, 1);
		for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
			h.canvas.dispatchEvent(new PointerEvent(type, { pointerId: 2, pointerType: 'touch', bubbles: true }));
		}
		expect(h.strokes.forKey(h.key)).toHaveLength(0);
		expect(h.decisions).not.toHaveBeenCalled();
	});
});
