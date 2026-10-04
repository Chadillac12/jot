/* @vitest-environment happy-dom */
/* eslint-disable @typescript-eslint/unbound-method, obsidianmd/no-global-this */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LongPressDetector } from '../src/long-press';
import type { OverlayManager } from '../src/overlay-manager';
import type { Palette } from '../src/palette';
import type { PaletteActivation } from '../src/palette-activation';
import { PointerEventHandler } from '../src/pointer-event-handler';
import type { SidecarStore } from '../src/sidecar-store';
import { StrokeStore } from '../src/stroke-store';
import type { UndoController } from '../src/undo-controller';

vi.mock('../src/overlay-manager', () => ({ OVERLAY_KEY_ATTR: 'data-jot-key' }));

interface Harness {
	canvas: HTMLCanvasElement;
	palette: Palette;
	strokes: StrokeStore;
	sidecar: SidecarStore;
	undo: UndoController;
	activation: { value: PaletteActivation };
}

function makeContext(): CanvasRenderingContext2D {
	return {
		save: vi.fn(),
		restore: vi.fn(),
		setTransform: vi.fn(),
		beginPath: vi.fn(),
		moveTo: vi.fn(),
		lineTo: vi.fn(),
		quadraticCurveTo: vi.fn(),
		closePath: vi.fn(),
		fill: vi.fn(),
		stroke: vi.fn(),
		clearRect: vi.fn(),
		fillStyle: '',
		strokeStyle: '',
		lineWidth: 1,
		lineCap: 'butt',
		lineJoin: 'miter',
		globalAlpha: 1,
	} as unknown as CanvasRenderingContext2D;
}

function makeHarness(
	activation: PaletteActivation = 'pencil-double-tap-hold',
	pointerCaptureFails = false,
): Harness {
	const canvas = document.createElement('canvas');
	canvas.setAttribute('data-jot-key', 'notes.pdf::1');
	canvas.getBoundingClientRect = () =>
		({
			left: 0,
			top: 0,
			right: 100,
			bottom: 100,
			width: 100,
			height: 100,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		});
	Object.defineProperty(canvas, 'setPointerCapture', {
		value: pointerCaptureFails ? vi.fn(() => { throw new Error('capture failed'); }) : vi.fn(),
	});
	Object.defineProperty(canvas, 'releasePointerCapture', { value: vi.fn() });
	document.body.appendChild(canvas);

	const palette = {
		isOpen: vi.fn(() => false),
		show: vi.fn(),
	} as unknown as Palette;
	const strokes = new StrokeStore();
	const sidecar = { scheduleSave: vi.fn() } as unknown as SidecarStore;
	const overlays = {
		clearLivePage: vi.fn(),
		appendPersistedStroke: vi.fn(),
		redrawPage: vi.fn(),
	} as unknown as OverlayManager;
	const undo = {
		push: vi.fn(),
		discardLatestTransient: vi.fn((_pdfPath: string, key: string) => {
			const current = strokes.forKey(key);
			if (current.length === 0) return false;
			strokes.setForKey(key, current.slice(0, -1));
			return true;
		}),
	} as unknown as UndoController;
	const currentActivation = { value: activation };

	new PointerEventHandler(canvas, makeContext(), {
		palette,
		strokes,
		overlays,
		sidecar,
		undo,
		toolState: () => ({ tool: 'pen', color: '#000000', width: 0.0025 }),
		handedness: () => 'right',
		paletteActivation: () => currentActivation.value,
	}).attach();

	return { canvas, palette, strokes, sidecar, undo, activation: currentActivation };
}

function pointer(
	canvas: HTMLCanvasElement,
	type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
	pointerType: 'pen' | 'touch' | 'mouse',
	pointerId: number,
	x: number,
	y: number,
): void {
	canvas.dispatchEvent(
		new PointerEvent(type, {
			bubbles: true,
			pointerType,
			pointerId,
			clientX: x,
			clientY: y,
			pressure: pointerType === 'pen' ? 0.6 : 0.5,
		}),
	);
}

describe('PointerEventHandler palette activation', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		Object.defineProperty(globalThis, 'activeDocument', {
			value: document,
			configurable: true,
		});
		window.requestAnimationFrame = (callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		};
		window.cancelAnimationFrame = vi.fn();
	});

	afterEach(() => {
		document.body.innerHTML = '';
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('never arms ordinary Pencil long-press', () => {
		const start = vi.spyOn(LongPressDetector.prototype, 'start');
		const { canvas } = makeHarness();

		pointer(canvas, 'pointerdown', 'pen', 1, 20, 20);

		expect(start).not.toHaveBeenCalled();
		expect(document.querySelector('.jot-hold-indicator')).toBeNull();
	});

	it('continues writing when WKWebView pointer capture fails', () => {
		const { canvas, strokes } = makeHarness('pencil-double-tap-hold', true);

		pointer(canvas, 'pointerdown', 'pen', 1, 20, 20);
		pointer(canvas, 'pointermove', 'pen', 1, 40, 40);
		pointer(canvas, 'pointerup', 'pen', 1, 50, 50);

		expect(strokes.forKey('notes.pdf::1')).toHaveLength(1);
		expect(strokes.forKey('notes.pdf::1')[0]?.points.length).toBeGreaterThan(1);
	});

	it('records and schedules an ordinary Pencil tap', () => {
		const { canvas, strokes, sidecar } = makeHarness();

		pointer(canvas, 'pointerdown', 'pen', 1, 20, 30);
		vi.advanceTimersByTime(50);
		pointer(canvas, 'pointerup', 'pen', 1, 20, 30);

		expect(strokes.forKey('notes.pdf::1')).toHaveLength(1);
		expect(strokes.forKey('notes.pdf::1')[0]?.points[0]).toMatchObject({
			x: 0.2,
			y: 0.3,
			pressure: 0.6,
		});
		expect(sidecar.scheduleSave).toHaveBeenCalledWith('notes.pdf');
	});

	it('discards a cancelled Pencil stroke instead of persisting a partial line', () => {
		const { canvas, strokes, sidecar, undo } = makeHarness();

		pointer(canvas, 'pointerdown', 'pen', 1, 20, 20);
		pointer(canvas, 'pointermove', 'pen', 1, 50, 50);
		pointer(canvas, 'pointercancel', 'pen', 1, 55, 55);

		expect(strokes.forKey('notes.pdf::1')).toHaveLength(0);
		expect(sidecar.scheduleSave).not.toHaveBeenCalled();
		expect(undo.push).not.toHaveBeenCalled();
	});

	it('opens the palette on quick tap then nearby hold and removes the gesture mark', () => {
		const { canvas, palette, strokes, undo } = makeHarness();

		pointer(canvas, 'pointerdown', 'pen', 1, 25, 25);
		vi.advanceTimersByTime(50);
		pointer(canvas, 'pointerup', 'pen', 1, 25, 25);
		expect(strokes.forKey('notes.pdf::1')).toHaveLength(1);

		vi.advanceTimersByTime(100);
		pointer(canvas, 'pointerdown', 'pen', 2, 27, 26);
		expect(document.querySelector('.jot-hold-indicator')).not.toBeNull();
		vi.advanceTimersByTime(280);

		expect(palette.show).toHaveBeenCalledTimes(1);
		expect(strokes.forKey('notes.pdf::1')).toHaveLength(0);
		expect(undo.discardLatestTransient).toHaveBeenCalledWith('notes.pdf', 'notes.pdf::1');
		expect(document.querySelector('.jot-hold-indicator')).toBeNull();
	});

	it('cancels the palette gesture when the second contact starts writing', () => {
		const { canvas, palette } = makeHarness();

		pointer(canvas, 'pointerdown', 'pen', 1, 25, 25);
		vi.advanceTimersByTime(40);
		pointer(canvas, 'pointerup', 'pen', 1, 25, 25);
		vi.advanceTimersByTime(100);
		pointer(canvas, 'pointerdown', 'pen', 2, 27, 26);
		pointer(canvas, 'pointermove', 'pen', 2, 60, 60);
		vi.advanceTimersByTime(400);

		expect(palette.show).not.toHaveBeenCalled();
	});

	it('does not take over two-finger gestures in recommended mode', () => {
		const { canvas, palette } = makeHarness();

		pointer(canvas, 'pointerdown', 'touch', 10, 20, 40);
		pointer(canvas, 'pointerdown', 'touch', 11, 40, 40);
		vi.advanceTimersByTime(500);

		expect(palette.show).not.toHaveBeenCalled();
	});

	it('keeps two-finger hold available when explicitly selected', () => {
		const { canvas, palette } = makeHarness('two-finger');

		pointer(canvas, 'pointerdown', 'touch', 10, 20, 40);
		pointer(canvas, 'pointerdown', 'touch', 11, 40, 40);
		vi.advanceTimersByTime(300);

		expect(palette.show).toHaveBeenCalledTimes(1);
	});
});
