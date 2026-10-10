/* @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutsideCloseListener } from '../src/outside-close-listener';

describe('Palette outside-dismiss after activation', () => {
	afterEach(() => {
		vi.useRealTimers();
		document.body.innerHTML = '';
	});

	it('ignores the opening pointer burst but responds to a later outside touch', async () => {
		vi.useFakeTimers();
		const palette = document.createElement('div');
		document.body.appendChild(palette);
		const close = vi.fn();
		const listener = new OutsideCloseListener(() => palette, close);
		listener.attach(document);

		document.body.dispatchEvent(new PointerEvent('pointerdown', {
			bubbles: true, pointerId: 7, pointerType: 'touch',
		}));
		expect(close).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(120);
		palette.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		expect(close).not.toHaveBeenCalled();

		document.body.dispatchEvent(new PointerEvent('pointerdown', {
			bubbles: true, pointerId: 8, pointerType: 'touch',
		}));
		expect(close).toHaveBeenCalledTimes(1);
		listener.detach();
	});

	it('cancels pending outside listener on palette hide', async () => {
		vi.useFakeTimers();
		const palette = document.createElement('div');
		document.body.appendChild(palette);
		const close = vi.fn();
		const listener = new OutsideCloseListener(() => palette, close);
		listener.attach(document);
		listener.detach();
		await vi.advanceTimersByTimeAsync(200);
		document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		expect(close).not.toHaveBeenCalled();
	});
});
