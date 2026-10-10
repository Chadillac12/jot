/* @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest';
import { Palette } from '../src/palette';

vi.mock('obsidian', () => ({ setIcon: vi.fn() }));

describe('Palette DOM lifetime', () => {
	it('clears stale palette state when Obsidian removes the element without hide', () => {
		const visibility = vi.fn();
		const palette = new Palette(
			{ tool: 'pen', color: '#000000', width: 0.0025 },
			vi.fn(),
			{
				onUndo: vi.fn(),
				onRedo: vi.fn(),
				canUndo: () => false,
				canRedo: () => false,
				onVisibilityChanged: visibility,
			},
		);
		const element = document.createElement('div');
		document.body.appendChild(element);
		const internals = palette as unknown as { element: HTMLElement | null };
		internals.element = element;
		expect(palette.isOpen()).toBe(true);
		element.remove();
		expect(palette.isOpen()).toBe(false);
		expect(internals.element).toBeNull();
		expect(visibility).toHaveBeenCalledWith(false, 'detached');
	});
});
