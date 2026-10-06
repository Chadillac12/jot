import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => ({
	setIcon: vi.fn(),
}));

import {
	DEFAULT_HIGHLIGHTER_MEMORY,
	DEFAULT_PEN_MEMORY,
	Palette,
	type ToolState,
} from '../src/palette';

describe('Palette.selectTool', () => {
	it('uses the same remembered drawing-tool state as the radial palette', () => {
		const changes: ToolState[] = [];
		const palette = new Palette(
			{ tool: 'pen', ...DEFAULT_PEN_MEMORY },
			(state) => changes.push({ ...state }),
			{
				onUndo: vi.fn(),
				onRedo: vi.fn(),
				canUndo: () => false,
				canRedo: () => false,
			},
			{
				pen: { ...DEFAULT_PEN_MEMORY },
				highlighter: { ...DEFAULT_HIGHLIGHTER_MEMORY },
			},
		);

		palette.selectTool('highlighter');
		expect(palette.getState()).toEqual({
			tool: 'highlighter',
			...DEFAULT_HIGHLIGHTER_MEMORY,
		});

		palette.selectTool('eraser');
		expect(palette.getState().tool).toBe('eraser');

		palette.selectTool('pen');
		expect(palette.getState()).toEqual({
			tool: 'pen',
			...DEFAULT_PEN_MEMORY,
		});
		expect(changes.map((state) => state.tool)).toEqual(['highlighter', 'eraser', 'pen']);
	});
});
