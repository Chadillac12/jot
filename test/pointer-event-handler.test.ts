/* @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LongPressDetector } from '../src/long-press';
import type { Palette } from '../src/palette';
import type { PaletteActivation } from '../src/palette-activation';
import { PointerEventHandler } from '../src/pointer-event-handler';
import { StrokeStore } from '../src/stroke-store';
import type { SidecarStore } from '../src/sidecar-store';
import type { UndoController } from '../src/undo-controller';
import type { OverlayManager } from '../src/overlay-manager';

vi.mock('../src/overlay-manager', () => ({ OVERLAY_KEY_ATTR: 'data-jot-key' }));

interface Harness {
	canvas: HTMLCanvasElement;
	palette: Palette;
	strokes: StrokeStore;
	sidecar: SidecarStore;
	undo: UndoController;
	overlays: OverlayManager;
	activation: { value: PaletteActivation };
}

function makeHarness(activation: PaletteActivation = 'pencil-double-tap-hold'): Harness {
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
		}) as DOMRect;
	Object.defineProperty(canvas, 'setPointerCapture', { value: vi.fn() });
	Object.defineProperty(canvas, 'releasePointerCapture', { value: vi.fn() });
	document.body.appendChild(canvas);

	const palette = {
		isOpen: vi.fn(() => false),
		show: vi.fn(),
	} as unknown as Palette;
	const strokes = new StrokeStore();
	const sidecar = { scheduleSave: vi.fn() } as unknown as SidecarStore;
	const overlays = {
		redrawPage: vi.fn(),
		prepareForInput: vi.fn(),
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

	new PointerEventHandler(canvas, {} as CanvasRenderingContext2D, {
		palette,
		strokes,
		overlays,
		sidecar,
		undo,
		toolState: () => ({ tool: 'pen', color: '#000000', width: 0.0025 }),
		handedness: () => 'right',
		paletteActivation: () => currentActivation.value,
		pencilLongPressMs: () => 300,
	}).attach();

	return { canvas, palette, strokes, sidecar, undo, overlays, activation: currentActivation };
}

function pointer(
	canvas: HTMLCanvasElement,
	type: 'pointerdown' | 'pointermove' | 'pointerup',
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
	});

	afterEach(() => {
		document.body.innerHTML = '';
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('prepares a virtualized overlay before Pencil input starts', () => {
		const { canvas, overlays } = makeHarness();

		pointer(canvas, 'pointerdown', 'pen', 1, 20, 20);

		expect(overlays.prepareForInput).toHaveBeenCalledWith(canvas);
	});

	it('does not arm LongPressDetector on ordinary Pencil down in double-tap-hold mode', () => {
		const start = vi.spyOn(LongPressDetector.prototype, 'start');
		const { canvas } = makeHarness();

		pointer(canvas, 'pointerdown', 'pen', 1, 20, 20);

		expect(start).not.toHaveBeenCalled();
	});

	it('does not show a hold indicator on the first Pencil tap', () => {
		const { canvas } = makeHarness();

		pointer(canvas, 'pointerdown', 'pen', 1, 20, 20);

		expect(document.querySelector('.jot-hold-indicator')).toBeNull();
	});

	it('still records and schedules an ordinary Pencil tap', () => {
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

	it('opens the palette on a quick Pencil tap followed by a nearby hold and removes the gesture mark', () => {
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

	it('does not treat two fingers as palette activation in double-tap-hold mode', () => {
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
		expect(document.querySelector('.jot-hold-indicator')).toBeNull();
	});

	it('restores the old Pencil long-press behavior when enabled', () => {
		const start = vi.spyOn(LongPressDetector.prototype, 'start');
		const { canvas, palette } = makeHarness('pencil-long-press');

		pointer(canvas, 'pointerdown', 'pen', 1, 25, 25);
		expect(start).toHaveBeenCalledWith(25, 25, 300);
		expect(document.querySelector('.jot-hold-indicator')).not.toBeNull();
		vi.advanceTimersByTime(300);
		expect(palette.show).toHaveBeenCalledTimes(1);
	});

	it('allows Pencil long-press and two-finger hold in legacy both mode', () => {
		const start = vi.spyOn(LongPressDetector.prototype, 'start');
		const { canvas, palette } = makeHarness('both');

		pointer(canvas, 'pointerdown', 'pen', 1, 25, 25);
		expect(start).toHaveBeenCalledTimes(1);
		pointer(canvas, 'pointerup', 'pen', 1, 25, 25);

		pointer(canvas, 'pointerdown', 'touch', 10, 20, 40);
		pointer(canvas, 'pointerdown', 'touch', 11, 40, 40);
		vi.advanceTimersByTime(300);
		expect(palette.show).toHaveBeenCalledTimes(1);
	});
});
