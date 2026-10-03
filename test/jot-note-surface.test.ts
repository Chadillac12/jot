/* @vitest-environment happy-dom */
/* eslint-disable
	obsidianmd/prefer-active-doc,
	obsidianmd/no-global-this,
	@typescript-eslint/no-explicit-any,
	@typescript-eslint/no-unsafe-member-access
*/
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { documentPageKey } from '../src/jot-file';
import { createJotNote, createJotPage } from '../src/jot-note-file';
import { JotNoteSurface } from '../src/jot-note-surface';
import { StrokeStore } from '../src/stroke-store';

class ResizeObserverMock {
	constructor(private callback: ResizeObserverCallback) {}
	observe(): void {
		this.callback([], this as unknown as ResizeObserver);
	}
	disconnect(): void {}
	unobserve(): void {}
}

beforeEach(() => {
	document.body.innerHTML = '';
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

	it('caps both notebook canvas backing stores at the iPad-safe area', () => {
		const host = document.createElement('div');
		const surface = new JotNoteSurface(host, new StrokeStore(), vi.fn());

		surface.render(createJotNote(), 'Lecture.jot');

		for (const canvas of Array.from(host.querySelectorAll<HTMLCanvasElement>('canvas'))) {
			expect(canvas.width * canvas.height).toBeLessThanOrEqual(16_777_216);
		}
	});
});
