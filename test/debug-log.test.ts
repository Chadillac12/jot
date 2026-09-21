import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	jotDebug,
	jotDebugId,
	resetJotDebugStateForTests,
	setJotDebugEnabled,
} from '../src/debug-log';

afterEach(() => {
	resetJotDebugStateForTests();
	vi.restoreAllMocks();
});

describe('Jot debug logging', () => {
	it('is silent by default', () => {
		const spy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
		jotDebug('overlay created', { page: 'page-1' });
		expect(spy).not.toHaveBeenCalled();
	});

	it('logs concise lifecycle details when enabled', () => {
		const spy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
		setJotDebugEnabled(true);
		jotDebug('pointerdown', { overlay: 'overlay-2', connected: 1 });
		expect(spy).toHaveBeenCalledWith('[JOT] pointerdown overlay=overlay-2 connected=1');
	});

	it('assigns stable ids to the same target', () => {
		const target = {};
		expect(jotDebugId(target, 'page')).toBe('page-1');
		expect(jotDebugId(target, 'page')).toBe('page-1');
	});

	it('assigns different ids to different targets', () => {
		expect(jotDebugId({}, 'page')).toBe('page-1');
		expect(jotDebugId({}, 'overlay')).toBe('overlay-2');
	});

	it('reset restores the disabled state and id sequence', () => {
		const spy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
		setJotDebugEnabled(true);
		expect(jotDebugId({}, 'page')).toBe('page-1');
		resetJotDebugStateForTests();
		expect(jotDebugId({}, 'page')).toBe('page-1');
		jotDebug('should stay silent');
		expect(spy).not.toHaveBeenCalled();
	});
});
