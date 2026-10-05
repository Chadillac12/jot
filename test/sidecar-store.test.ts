import type { DataAdapter } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentSessionManager } from '../src/document-session';
import { JOT_FORMAT_VERSION } from '../src/jot-file';
import { SidecarStore } from '../src/sidecar-store';
import { StrokeStore } from '../src/stroke-store';

interface FileSystem {
	files: Record<string, string>;
	adapter: DataAdapter;
	failNextWrite: () => void;
	failNextCommitRename: () => void;
}

const makeFs = (initial: Record<string, string> = {}): FileSystem => {
	const files: Record<string, string> = { ...initial };
	let failWrite = false;
	let failCommitRename = false;
	const adapter = {
		exists: vi.fn(async (path: string) => path in files),
		read: vi.fn(async (path: string) => files[path] ?? ''),
		write: vi.fn(async (path: string, data: string) => {
			if (failWrite) {
				failWrite = false;
				throw new Error('injected write failure');
			}
			files[path] = data;
		}),
		remove: vi.fn(async (path: string) => {
			delete files[path];
		}),
		rename: vi.fn(async (oldPath: string, newPath: string) => {
			if (failCommitRename && oldPath.endsWith('.jot-tmp')) {
				failCommitRename = false;
				throw new Error('injected commit rename failure');
			}
			files[newPath] = files[oldPath] ?? '';
			delete files[oldPath];
		}),
	} as unknown as DataAdapter;
	return {
		files,
		adapter,
		failNextWrite: () => {
			failWrite = true;
		},
		failNextCommitRename: () => {
			failCommitRename = true;
		},
	};
};

const stroke = (color = '#000000') => ({
	points: [{ x: 0.1, y: 0.2, pressure: 0.5 }],
	color,
	width: 0.005,
	tool: 'pen' as const,
	render: { version: 2 as const, smoothing: 0.5, pressureSensitivity: 0.5 },
});

const validPayload = JSON.stringify({
	version: JOT_FORMAT_VERSION,
	pages: { '1': [stroke()] },
});

function makeStore(fs = makeFs()) {
	const strokes = new StrokeStore();
	const sessions = new DocumentSessionManager();
	const onSaveError = vi.fn();
	const onSaveRecovered = vi.fn();
	const store = new SidecarStore(fs.adapter, strokes, sessions, {
		onSaveError,
		onSaveRecovered,
	});
	return { fs, strokes, sessions, store, onSaveError, onSaveRecovered };
}

describe('SidecarStore session loading', () => {
	it('loads validated sidecar data into a clean session', async () => {
		const h = makeStore(makeFs({ 'a.pdf.jot.json': validPayload }));
		expect(await h.store.load('a.pdf')).toBe('loaded');
		expect(h.strokes.forPage('a.pdf', 1)).toHaveLength(1);
		expect(h.sessions.get('a.pdf').state).toBe('clean');
	});

	it('does not replace dirty in-memory ink with an older disk copy', async () => {
		const h = makeStore(makeFs({ 'a.pdf.jot.json': validPayload }));
		await h.store.load('a.pdf');
		h.strokes.setForKey('a.pdf::1', [stroke('#00ff00')]);
		h.store.scheduleSave('a.pdf');

		expect(await h.store.load('a.pdf')).toBe('dirty');
		expect(h.strokes.forPage('a.pdf', 1)[0]?.color).toBe('#00ff00');
	});

	it('protects malformed sidecars without clearing current memory', async () => {
		const h = makeStore(makeFs({ 'a.pdf.jot.json': '{bad' }));
		h.strokes.setForKey('a.pdf::1', [stroke('#112233')]);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(await h.store.load('a.pdf')).toBe('protected');
		expect(h.strokes.forPage('a.pdf', 1)[0]?.color).toBe('#112233');
		warn.mockRestore();
	});
});

describe('SidecarStore lifecycle persistence', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('debounces edits but transactionally commits after the quiet period', async () => {
		const h = makeStore();
		h.strokes.setForKey('a.pdf::1', [stroke('#123456')]);
		h.store.scheduleSave('a.pdf');
		h.store.scheduleSave('a.pdf');
		await vi.advanceTimersByTimeAsync(749);
		expect(h.fs.files['a.pdf.jot.json']).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect(h.fs.files['a.pdf.jot.json']).toContain('#123456');
		expect(h.sessions.get('a.pdf').state).toBe('clean');
	});

	it('flushAll writes pending edits instead of discarding them', async () => {
		const h = makeStore();
		h.strokes.setForKey('a.pdf::1', [stroke('#abcdef')]);
		h.store.scheduleSave('a.pdf');

		expect(await h.store.flushAll()).toBe(true);
		expect(h.fs.files['a.pdf.jot.json']).toContain('#abcdef');
		expect(h.store.hasPendingSave('a.pdf')).toBe(false);
	});

	it('flushAll persists pending edits instead of losing them', async () => {
		const h = makeStore();
		h.strokes.setForKey('a.pdf::1', [stroke('#fedcba')]);
		h.store.scheduleSave('a.pdf');
		expect(await h.store.flushAll()).toBe(true);
		expect(h.fs.files['a.pdf.jot.json']).toContain('#fedcba');
	});

	it('failed saves remain dirty, surface an error, then retry successfully', async () => {
		const h = makeStore();
		h.strokes.setForKey('a.pdf::1', [stroke('#010203')]);
		h.fs.failNextWrite();
		h.store.scheduleSave('a.pdf');

		await vi.advanceTimersByTimeAsync(750);
		expect(h.sessions.get('a.pdf').state).toBe('error');
		expect(h.sessions.get('a.pdf').isDirty).toBe(true);
		expect(h.onSaveError).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1500);
		expect(h.fs.files['a.pdf.jot.json']).toContain('#010203');
		expect(h.sessions.get('a.pdf').state).toBe('clean');
	});

	it('a commit-rename failure rolls the original sidecar back intact', async () => {
		const original = validPayload;
		const h = makeStore(makeFs({ 'a.pdf.jot.json': original }));
		await h.store.load('a.pdf');
		h.strokes.setForKey('a.pdf::1', [stroke('#445566')]);
		h.fs.failNextCommitRename();
		h.store.scheduleSave('a.pdf');

		await vi.advanceTimersByTimeAsync(750);
		expect(h.fs.files['a.pdf.jot.json']).toBe(original);
		expect(h.sessions.get('a.pdf').state).toBe('error');
	});

	it('a newer edit made during an in-flight save remains dirty and is persisted next', async () => {
		const h = makeStore();
		h.strokes.setForKey('a.pdf::1', [stroke('#111111')]);
		h.sessions.get('a.pdf').markDirty();
		const first = h.store.save('a.pdf');
		h.strokes.setForKey('a.pdf::1', [stroke('#222222')]);
		h.sessions.get('a.pdf').markDirty();
		const second = h.store.save('a.pdf');

		await Promise.all([first, second]);
		expect(h.fs.files['a.pdf.jot.json']).toContain('#222222');
		expect(h.sessions.get('a.pdf').state).toBe('clean');
	});

	it('clearing all strokes transactionally removes the sidecar', async () => {
		const h = makeStore(makeFs({ 'a.pdf.jot.json': validPayload }));
		await h.store.load('a.pdf');
		h.strokes.clearFor('a.pdf');
		h.store.scheduleSave('a.pdf');
		await h.store.flush('a.pdf');
		expect(h.fs.files['a.pdf.jot.json']).toBeUndefined();
	});
});

describe('SidecarStore conflicts and recovery', () => {
	it('preserves the external sidecar before local dirty ink wins', async () => {
		const remote = JSON.stringify({ version: JOT_FORMAT_VERSION, pages: { '1': [stroke('#ff0000')] } });
		const h = makeStore(makeFs({ 'a.pdf.jot.json': remote }));
		await h.store.load('a.pdf');
		h.strokes.setForKey('a.pdf::1', [stroke('#0000ff')]);
		h.store.scheduleSave('a.pdf');

		const conflictPath = await h.store.preserveExternalConflictAndFlushLocal('a.pdf');
		expect(conflictPath).not.toBeNull();
		expect(conflictPath ? h.fs.files[conflictPath] : undefined).toBe(remote);
		expect(h.fs.files['a.pdf.jot.json']).toContain('#0000ff');
	});

	it('backs up an unreadable original before replacing it with new ink', async () => {
		const original = '{not-json';
		const h = makeStore(makeFs({ 'a.pdf.jot.json': original }));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(await h.store.load('a.pdf')).toBe('protected');
		h.strokes.setForKey('a.pdf::1', [stroke('#00ff00')]);
		h.store.scheduleSave('a.pdf');
		await h.store.flush('a.pdf');

		const recovery = Object.keys(h.fs.files).find((path) =>
			path.startsWith('a.pdf.jot.json.recovery-'),
		);
		expect(recovery).toBeDefined();
		expect(recovery ? h.fs.files[recovery] : undefined).toBe(original);
		expect(h.fs.files['a.pdf.jot.json']).toContain('#00ff00');
		warn.mockRestore();
	});
});
