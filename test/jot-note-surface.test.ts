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

	it('keeps paper guide spacing tied to normalized page dimensions', () => {
		const host = document.createElement('div');
		const surface = new JotNoteSurface(host, new StrokeStore(), vi.fn());

		surface.render(createJotNote(), 'Lecture.jot');

		const sheet = host.querySelector<HTMLElement>('.jot-note-sheet');
		expect(sheet?.style.getPropertyValue('--jot-paper-x')).toBe(
			((64 / 1536) * 100).toString() + '%',
		);
		expect(sheet?.style.getPropertyValue('--jot-paper-y')).toBe(
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

		expect(host.querySelector('.jot-note-sheet')?.classList.contains('jot-note-paper-grid')).toBe(true);
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

	it('caps both notebook canvas backing stores at the iPad-safe area', () => {
		const host = document.createElement('div');
		const surface = new JotNoteSurface(host, new StrokeStore(), vi.fn());

		surface.render(createJotNote(), 'Lecture.jot');

		for (const canvas of Array.from(host.querySelectorAll<HTMLCanvasElement>('canvas'))) {
			expect(canvas.width * canvas.height).toBeLessThanOrEqual(16_777_216);
		}
	});
});
