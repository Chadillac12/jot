/* eslint-disable @typescript-eslint/unbound-method */
import type { DataAdapter } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentSessionManager } from '../src/document-session';
import { JOT_FORMAT_VERSION } from '../src/jot-file';
import { SidecarStore } from '../src/sidecar-store';
import { StrokeStore } from '../src/stroke-store';

interface FileSystem {
	files: Record<string, string>;
	adapter: DataAdapter;
}

const makeFs = (initial: Record<string, string> = {}): FileSystem => {
	const files: Record<string, string> = { ...initial };
	const adapter = {
		exists: vi.fn(async (path: string) => path in files),
		read: vi.fn(async (path: string) => files[path] ?? ''),
		write: vi.fn(async (path: string, data: string) => {
			files[path] = data;
		}),
		remove: vi.fn(async (path: string) => {
			delete files[path];
		}),
		rename: vi.fn(async (oldPath: string, newPath: string) => {
			files[newPath] = files[oldPath] ?? '';
			delete files[oldPath];
		}),
	} as unknown as DataAdapter;
	return { files, adapter };
};

const validPayload = JSON.stringify({
	version: JOT_FORMAT_VERSION,
	pages: { '1': [{ points: [{ x: 0, y: 0, pressure: 0.5 }], color: '#000', width: 0.005, tool: 'pen' }] },
});

describe('SidecarStore.load', () => {
	it('returns without populating strokes when the sidecar file does not exist', async () => {
		const fs = makeFs();
		const strokes = new StrokeStore();
		const store = new SidecarStore(fs.adapter, strokes);
		await store.load('a.pdf');
		expect(strokes.hasFor('a.pdf')).toBe(false);
	});

	it('clears any previously loaded strokes for the PDF on every call', async () => {
		const fs = makeFs();
		const strokes = new StrokeStore();
		strokes.setForKey('a.pdf::1', [
			{ points: [{ x: 0, y: 0, pressure: 0.5 }], color: '#000', width: 0.005, tool: 'pen' },
		]);
		const store = new SidecarStore(fs.adapter, strokes);
		await store.load('a.pdf');
		expect(strokes.hasFor('a.pdf')).toBe(false);
	});

	it('populates strokes from a valid sidecar file', async () => {
		const fs = makeFs({ 'a.pdf.jot.json': validPayload });
		const strokes = new StrokeStore();
		const store = new SidecarStore(fs.adapter, strokes);
		await store.load('a.pdf');
		expect(strokes.forPage('a.pdf', 1)).toHaveLength(1);
	});

	it('keeps existing in-memory strokes when external JSON is malformed', async () => {
		const fs = makeFs({ 'a.pdf.jot.json': 'not json at all' });
		const strokes = new StrokeStore();
		strokes.setForKey('a.pdf::1', [
			{ points: [{ x: 0.2, y: 0.2, pressure: 0.5 }], color: '#123', width: 0.005, tool: 'pen' },
		]);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const store = new SidecarStore(fs.adapter, strokes);
		await store.load('a.pdf');
		expect(strokes.forPage('a.pdf', 1)).toHaveLength(1);
		expect(strokes.forPage('a.pdf', 1)[0]?.color).toBe('#123');
		warn.mockRestore();
	});

	it('keeps existing in-memory strokes when the file version is unsupported', async () => {
		const fs = makeFs({
			'a.pdf.jot.json': JSON.stringify({ version: 99, pages: { '1': [] } }),
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const strokes = new StrokeStore();
		strokes.setForKey('a.pdf::1', [
			{ points: [{ x: 0.2, y: 0.2, pressure: 0.5 }], color: '#123', width: 0.005, tool: 'pen' },
		]);
		const store = new SidecarStore(fs.adapter, strokes);
		await store.load('a.pdf');
		expect(warn).toHaveBeenCalled();
		expect(strokes.forPage('a.pdf', 1)[0]?.color).toBe('#123');
		warn.mockRestore();
	});

	it('rejects malformed persisted stroke coordinates without clearing good memory', async () => {
		const fs = makeFs({
			'a.pdf.jot.json': JSON.stringify({
				version: JOT_FORMAT_VERSION,
				pages: {
					'1': [
						{ points: [{ x: 'bad', y: 0, pressure: 0.5 }], color: '#000', width: 0.005, tool: 'pen' },
					],
				},
			}),
		});
		const strokes = new StrokeStore();
		strokes.setForKey('a.pdf::1', [
			{ points: [{ x: 0.2, y: 0.2, pressure: 0.5 }], color: '#123', width: 0.005, tool: 'pen' },
		]);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const store = new SidecarStore(fs.adapter, strokes);
		await store.load('a.pdf');
		expect(strokes.forPage('a.pdf', 1)[0]?.color).toBe('#123');
		warn.mockRestore();
	});
});

describe('SidecarStore concurrency and failure handling', () => {
	it('refuses disk reload while local annotations are dirty', async () => {
		const remote = JSON.stringify({
			version: JOT_FORMAT_VERSION,
			pages: {
				'1': [
					{ points: [{ x: 0.9, y: 0.9, pressure: 0.5 }], color: '#ff0000', width: 0.005, tool: 'pen' },
				],
			},
		});
		const fs = makeFs({ 'a.pdf.jot.json': validPayload });
		const strokes = new StrokeStore();
		const store = new SidecarStore(fs.adapter, strokes);
		expect(await store.load('a.pdf')).toBe('loaded');

		strokes.setForKey('a.pdf::1', [
			{ points: [{ x: 0.1, y: 0.1, pressure: 0.5 }], color: '#0000ff', width: 0.005, tool: 'pen' },
		]);
		store.scheduleSave('a.pdf');
		fs.files['a.pdf.jot.json'] = remote;

		expect(await store.load('a.pdf')).toBe('dirty');
		expect(strokes.forPage('a.pdf', 1)[0]?.color).toBe('#0000ff');
	});

	it('keeps local ink when an edit arrives during an in-flight reload', async () => {
		vi.useFakeTimers();
		const remote = JSON.stringify({
			version: JOT_FORMAT_VERSION,
			pages: {
				'1': [
					{ points: [{ x: 0.9, y: 0.9, pressure: 0.5 }], color: '#ff0000', width: 0.005, tool: 'pen' },
				],
			},
		});
		const fs = makeFs({ 'a.pdf.jot.json': validPayload });
		const sessions = new DocumentSessionManager();
		const strokes = new StrokeStore();
		const store = new SidecarStore(fs.adapter, strokes, sessions);
		expect(await store.load('a.pdf')).toBe('loaded');

		let releaseRead!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		let blockNextRead = true;
		const originalRead = vi.mocked(fs.adapter.read).getMockImplementation()!;
		vi.mocked(fs.adapter.read).mockImplementation(async (path: string) => {
			if (blockNextRead && path === 'a.pdf.jot.json') {
				blockNextRead = false;
				await gate;
			}
			return originalRead(path);
		});
		fs.files['a.pdf.jot.json'] = remote;

		const reload = store.load('a.pdf');
		await Promise.resolve();
		await Promise.resolve();

		strokes.setForKey('a.pdf::1', [
			{ points: [{ x: 0.1, y: 0.1, pressure: 0.5 }], color: '#0000ff', width: 0.005, tool: 'pen' },
		]);
		store.scheduleSave('a.pdf');
		releaseRead();

		expect(await reload).toBe('dirty');
		expect(strokes.forPage('a.pdf', 1)[0]?.color).toBe('#0000ff');
		expect(sessions.get('a.pdf').isDirty).toBe(true);
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it('keeps a newer edit dirty when it arrives during an in-flight save', async () => {
		const fs = makeFs();
		const strokes = new StrokeStore();
		const store = new SidecarStore(fs.adapter, strokes);
		let releaseWrite!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		let firstWrite = true;
		const originalWrite = vi.mocked(fs.adapter.write).getMockImplementation()!;
		vi.mocked(fs.adapter.write).mockImplementation(async (path: string, data: string) => {
			if (firstWrite) {
				firstWrite = false;
				await gate;
			}
			await originalWrite(path, data);
		});

		strokes.setForKey('a.pdf::1', [
			{ points: [{ x: 0.1, y: 0.1, pressure: 0.5 }], color: '#111111', width: 0.005, tool: 'pen' },
		]);
		store.scheduleSave('a.pdf');
		const firstFlush = store.flush('a.pdf');
		await Promise.resolve();

		strokes.setForKey('a.pdf::1', [
			{ points: [{ x: 0.2, y: 0.2, pressure: 0.5 }], color: '#222222', width: 0.005, tool: 'pen' },
		]);
		store.scheduleSave('a.pdf');
		releaseWrite();
		expect(await firstFlush).toBe(true);
		expect(store.hasPendingSave('a.pdf')).toBe(true);

		expect(await store.flush('a.pdf')).toBe(true);
		expect(fs.files['a.pdf.jot.json']).toContain('#222222');
		expect(store.hasPendingSave('a.pdf')).toBe(false);
	});

	it('flushAll waits for an in-flight save and persists a later revision before succeeding', async () => {
		const fs = makeFs();
		const strokes = new StrokeStore();
		const store = new SidecarStore(fs.adapter, strokes);
		let releaseWrite!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		let firstWrite = true;
		const originalWrite = vi.mocked(fs.adapter.write).getMockImplementation()!;
		vi.mocked(fs.adapter.write).mockImplementation(async (path: string, data: string) => {
			if (firstWrite) {
				firstWrite = false;
				await gate;
			}
			await originalWrite(path, data);
		});

		strokes.setForKey('a.pdf::1', [
			{ points: [{ x: 0.1, y: 0.1, pressure: 0.5 }], color: '#111111', width: 0.005, tool: 'pen' },
		]);
		store.scheduleSave('a.pdf');
		const firstSave = store.flush('a.pdf');
		await Promise.resolve();

		strokes.setForKey('a.pdf::1', [
			{ points: [{ x: 0.2, y: 0.2, pressure: 0.5 }], color: '#222222', width: 0.005, tool: 'pen' },
		]);
		store.scheduleSave('a.pdf');
		const lifecycleFlush = store.flushAll();

		releaseWrite();
		expect(await firstSave).toBe(true);
		expect(await lifecycleFlush).toBe(true);
		expect(fs.files['a.pdf.jot.json']).toContain('#222222');
		expect(store.hasPendingSave('a.pdf')).toBe(false);
	});

	it('preserves a synced sidecar change that arrives without a modify event before commit', async () => {
		const fs = makeFs({ 'a.pdf.jot.json': validPayload });
		const strokes = new StrokeStore();
		const store = new SidecarStore(fs.adapter, strokes);
		expect(await store.load('a.pdf')).toBe('loaded');

		strokes.setForKey('a.pdf::1', [
			{ points: [{ x: 0.2, y: 0.2, pressure: 0.5 }], color: '#0000ff', width: 0.005, tool: 'pen' },
		]);
		store.scheduleSave('a.pdf');

		const remote = JSON.stringify({
			version: JOT_FORMAT_VERSION,
			pages: {
				'1': [
					{ points: [{ x: 0.8, y: 0.8, pressure: 0.5 }], color: '#ff0000', width: 0.005, tool: 'pen' },
				],
			},
		});
		fs.files['a.pdf.jot.json'] = remote;

		expect(await store.flush('a.pdf')).toBe(true);
		expect(fs.files['a.pdf.jot.json']).toContain('#0000ff');
		const conflictPath = Object.keys(fs.files).find((path) =>
			path.startsWith('a.pdf.jot.json.conflict-'),
		);
		expect(conflictPath).toBeDefined();
		expect(conflictPath ? fs.files[conflictPath] : undefined).toBe(remote);
		expect(store.hasPendingSave('a.pdf')).toBe(false);
	});

	it('reports a failed save, keeps the revision dirty, and retries successfully', async () => {
		vi.useFakeTimers();
		const fs = makeFs();
		const strokes = new StrokeStore();
		const onError = vi.fn();
		const store = new SidecarStore(fs.adapter, strokes, undefined, onError);
		vi.mocked(fs.adapter.write).mockRejectedValueOnce(new Error('disk full'));
		strokes.setForKey('a.pdf::1', [
			{ points: [{ x: 0.3, y: 0.3, pressure: 0.5 }], color: '#333333', width: 0.005, tool: 'pen' },
		]);

		store.scheduleSave('a.pdf');
		await vi.advanceTimersByTimeAsync(750);
		expect(onError).toHaveBeenCalledTimes(1);
		expect(store.hasPendingSave('a.pdf')).toBe(true);

		await vi.advanceTimersByTimeAsync(2000);
		expect(fs.files['a.pdf.jot.json']).toContain('#333333');
		expect(store.hasPendingSave('a.pdf')).toBe(false);
		vi.useRealTimers();
	});
});

describe('SidecarStore protected originals', () => {
	it('does not delete an unreadable original when there are no local strokes', async () => {
		const original = '{not-json';
		const fs = makeFs({ 'a.pdf.jot.json': original });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const store = new SidecarStore(fs.adapter, new StrokeStore());

		expect(await store.load('a.pdf')).toBe('protected');
		await store.save('a.pdf');

		expect(fs.files['a.pdf.jot.json']).toBe(original);
		warn.mockRestore();
	});

	it('backs up an unreadable original before writing new local annotations', async () => {
		const original = '{not-json';
		const fs = makeFs({ 'a.pdf.jot.json': original });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const strokes = new StrokeStore();
		const store = new SidecarStore(fs.adapter, strokes);

		expect(await store.load('a.pdf')).toBe('protected');
		strokes.setForKey('a.pdf::1', [
			{ points: [{ x: 0.1, y: 0.1, pressure: 0.5 }], color: '#0f0', width: 0.005, tool: 'pen' },
		]);
		store.scheduleSave('a.pdf');
		await store.flush('a.pdf');

		const recovery = Object.keys(fs.files).find((path) =>
			path.startsWith('a.pdf.jot.json.recovery-'),
		);
		expect(recovery).toBeDefined();
		expect(recovery ? fs.files[recovery] : undefined).toBe(original);
		expect(fs.files['a.pdf.jot.json']).toContain('#0f0');
		warn.mockRestore();
	});

	it('carries protected-original state to a renamed PDF path', async () => {
		const original = '{not-json';
		const fs = makeFs({ 'Old/a.pdf.jot.json': original });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const strokes = new StrokeStore();
		const store = new SidecarStore(fs.adapter, strokes);

		expect(await store.load('Old/a.pdf')).toBe('protected');
		strokes.rekeyDocumentPath('Old/a.pdf', 'New/a.pdf');
		await store.renamePdfPath('Old/a.pdf', 'New/a.pdf');
		strokes.setForKey('New/a.pdf::1', [
			{ points: [{ x: 0.2, y: 0.2, pressure: 0.5 }], color: '#00f', width: 0.005, tool: 'pen' },
		]);
		store.scheduleSave('New/a.pdf');
		await store.flush('New/a.pdf');

		const recovery = Object.keys(fs.files).find((path) =>
			path.startsWith('New/a.pdf.jot.json.recovery-'),
		);
		expect(recovery).toBeDefined();
		expect(recovery ? fs.files[recovery] : undefined).toBe(original);
		warn.mockRestore();
	});
});

describe('SidecarStore.save', () => {
	it('writes a JSON payload at the .jot.json path when strokes are present', async () => {
		const fs = makeFs();
		const strokes = new StrokeStore();
		strokes.setForKey('a.pdf::1', [
			{ points: [{ x: 0, y: 0, pressure: 0.5 }], color: '#000', width: 0.005, tool: 'pen' },
		]);
		const store = new SidecarStore(fs.adapter, strokes);
		store.scheduleSave('a.pdf');
		expect(await store.flush('a.pdf')).toBe(true);
		expect(fs.files['a.pdf.jot.json']).toBeDefined();
	});

	it('writes a valid empty sidecar when all strokes are cleared', async () => {
		const fs = makeFs({ 'a.pdf.jot.json': validPayload });
		const store = new SidecarStore(fs.adapter, new StrokeStore());
		store.scheduleSave('a.pdf');
		expect(await store.flush('a.pdf')).toBe(true);
		expect(fs.files['a.pdf.jot.json']).toContain('"pages": {}');
	});

	it('does nothing when there are no strokes and no file exists', async () => {
		const fs = makeFs();
		const store = new SidecarStore(fs.adapter, new StrokeStore());
		await store.save('a.pdf');
		expect(fs.adapter.remove).not.toHaveBeenCalled();
	});

	it('records the write path in the self-save tracker', async () => {
		const fs = makeFs();
		const strokes = new StrokeStore();
		strokes.setForKey('a.pdf::1', [
			{ points: [{ x: 0, y: 0, pressure: 0.5 }], color: '#000', width: 0.005, tool: 'pen' },
		]);
		const store = new SidecarStore(fs.adapter, strokes);
		store.scheduleSave('a.pdf');
		await store.flush('a.pdf');
		expect(store.isOwnRecentSave('a.pdf.jot.json')).toBe(true);
	});
});

describe('SidecarStore.scheduleSave', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('debounces calls — only saves once after the quiet period', async () => {
		const fs = makeFs();
		const strokes = new StrokeStore();
		strokes.setForKey('a.pdf::1', [
			{ points: [{ x: 0, y: 0, pressure: 0.5 }], color: '#000', width: 0.005, tool: 'pen' },
		]);
		const store = new SidecarStore(fs.adapter, strokes);
		store.scheduleSave('a.pdf');
		store.scheduleSave('a.pdf');
		store.scheduleSave('a.pdf');
		await vi.advanceTimersByTimeAsync(750);
		expect(fs.files['a.pdf.jot.json']).toBeDefined();
		expect(Object.keys(fs.files).filter((path) => path === 'a.pdf.jot.json')).toHaveLength(1);
	});

	it('does not save before the debounce window elapses', async () => {
		const fs = makeFs();
		const strokes = new StrokeStore();
		strokes.setForKey('a.pdf::1', [
			{ points: [{ x: 0, y: 0, pressure: 0.5 }], color: '#000', width: 0.005, tool: 'pen' },
		]);
		const store = new SidecarStore(fs.adapter, strokes);
		store.scheduleSave('a.pdf');
		await vi.advanceTimersByTimeAsync(100);
		expect(fs.adapter.write).not.toHaveBeenCalled();
	});

	it('tracks when local annotations still have a pending save', () => {
		const store = new SidecarStore(makeFs().adapter, new StrokeStore());
		expect(store.hasPendingSave('a.pdf')).toBe(false);
		store.scheduleSave('a.pdf');
		expect(store.hasPendingSave('a.pdf')).toBe(true);
	});

	it('returns unresolved when the external copy is preserved but local conflict flush fails', async () => {
		vi.useFakeTimers();
		const remotePayload = JSON.stringify({
			version: JOT_FORMAT_VERSION,
			pages: { '1': [{ points: [{ x: 0.9, y: 0.9, pressure: 0.5 }], color: '#f00', width: 0.005, tool: 'pen' }] },
		});
		const fs = makeFs({ 'a.pdf.jot.json': remotePayload });
		const strokes = new StrokeStore();
		strokes.setForKey('a.pdf::1', [
			{ points: [{ x: 0.1, y: 0.1, pressure: 0.5 }], color: '#00f', width: 0.005, tool: 'pen' },
		]);
		const originalWrite = vi.mocked(fs.adapter.write).getMockImplementation()!;
		vi.mocked(fs.adapter.write).mockImplementation(async (path: string, data: string) => {
			if (path.startsWith('a.pdf.jot.json.jot-tmp-')) throw new Error('disk full');
			await originalWrite(path, data);
		});
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const store = new SidecarStore(fs.adapter, strokes);
		store.scheduleSave('a.pdf');

		const conflictPath = await store.preserveExternalConflictAndFlushLocal('a.pdf');

		expect(conflictPath).toBeNull();
		expect(Object.keys(fs.files).some((path) => path.startsWith('a.pdf.jot.json.conflict-'))).toBe(true);
		expect(store.hasPendingSave('a.pdf')).toBe(true);
		error.mockRestore();
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it('preserves an external sidecar before flushing conflicting local ink', async () => {
		const remotePayload = JSON.stringify({
			version: JOT_FORMAT_VERSION,
			pages: {
				'1': [
					{ points: [{ x: 0.9, y: 0.9, pressure: 0.5 }], color: '#f00', width: 0.005, tool: 'pen' },
				],
			},
		});
		const fs = makeFs({ 'a.pdf.jot.json': remotePayload });
		const strokes = new StrokeStore();
		strokes.setForKey('a.pdf::1', [
			{ points: [{ x: 0.1, y: 0.1, pressure: 0.5 }], color: '#00f', width: 0.005, tool: 'pen' },
		]);
		const store = new SidecarStore(fs.adapter, strokes);
		store.scheduleSave('a.pdf');

		const conflictPath = await store.preserveExternalConflictAndFlushLocal('a.pdf');

		expect(conflictPath).not.toBeNull();
		expect(conflictPath ? fs.files[conflictPath] : undefined).toBe(remotePayload);
		expect(fs.files['a.pdf.jot.json']).toContain('#00f');
		expect(store.hasPendingSave('a.pdf')).toBe(false);
	});
});

describe('SidecarStore.renamePdfPath', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('moves the sidecar to follow a renamed PDF', async () => {
		const fs = makeFs({ 'Old/Notes.pdf.jot.json': validPayload });
		const strokes = new StrokeStore();
		strokes.setForKey('New/Notes.pdf::1', [
			{ points: [{ x: 0, y: 0, pressure: 0.5 }], color: '#000', width: 0.005, tool: 'pen' },
		]);
		const store = new SidecarStore(fs.adapter, strokes);

		await store.renamePdfPath('Old/Notes.pdf', 'New/Notes.pdf');

		expect(fs.files['Old/Notes.pdf.jot.json']).toBeUndefined();
		expect(fs.files['New/Notes.pdf.jot.json']).toBe(validPayload);
	});

	it('preserves a synced source replacement that arrives during rename cleanup', async () => {
		const fs = makeFs({ 'Old/Notes.pdf.jot.json': validPayload });
		const store = new SidecarStore(fs.adapter, new StrokeStore());
		const remote = JSON.stringify({ version: JOT_FORMAT_VERSION, pages: { '9': [] } });
		const originalRename = vi.mocked(fs.adapter.rename).getMockImplementation()!;
		let injected = false;
		vi.mocked(fs.adapter.rename).mockImplementation(async (oldPath: string, newPath: string) => {
			await originalRename(oldPath, newPath);
			if (
				!injected &&
				oldPath === 'Old/Notes.pdf.jot.json' &&
				newPath.includes('.jot-backup-')
			) {
				injected = true;
				fs.files['Old/Notes.pdf.jot.json'] = remote;
			}
		});

		await store.renamePdfPath('Old/Notes.pdf', 'New/Notes.pdf');

		expect(fs.files['New/Notes.pdf.jot.json']).toBe(validPayload);
		expect(fs.files['Old/Notes.pdf.jot.json']).toBe(remote);
	});

	it('preserves an unexpected destination sidecar before replacing it', async () => {
		const existingDestination = JSON.stringify({ version: JOT_FORMAT_VERSION, pages: { '2': [] } });
		const fs = makeFs({
			'Old/Notes.pdf.jot.json': validPayload,
			'New/Notes.pdf.jot.json': existingDestination,
		});
		const store = new SidecarStore(fs.adapter, new StrokeStore());

		await store.renamePdfPath('Old/Notes.pdf', 'New/Notes.pdf');

		const conflict = Object.keys(fs.files).find((path) =>
			path.startsWith('New/Notes.pdf.jot.json.conflict-'),
		);
		expect(conflict).toBeDefined();
		expect(conflict ? fs.files[conflict] : undefined).toBe(existingDestination);
		expect(fs.files['New/Notes.pdf.jot.json']).toBe(validPayload);
	});

	it('waits for an in-flight save before moving PDF sidecar ownership', async () => {
		const fs = makeFs({ 'Old/Notes.pdf.jot.json': validPayload });
		const sessions = new DocumentSessionManager();
		const strokes = new StrokeStore();
		const store = new SidecarStore(fs.adapter, strokes, sessions);
		expect(await store.load('Old/Notes.pdf')).toBe('loaded');

		let releaseWrite!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		let firstWrite = true;
		const originalWrite = vi.mocked(fs.adapter.write).getMockImplementation()!;
		vi.mocked(fs.adapter.write).mockImplementation(async (path: string, data: string) => {
			if (firstWrite) {
				firstWrite = false;
				await gate;
			}
			await originalWrite(path, data);
		});

		strokes.setForKey('Old/Notes.pdf::1', [
			{ points: [{ x: 0.25, y: 0.25, pressure: 0.5 }], color: '#112233', width: 0.005, tool: 'pen' },
		]);
		store.scheduleSave('Old/Notes.pdf');
		const inFlight = store.flush('Old/Notes.pdf');
		await Promise.resolve();

		strokes.rekeyDocumentPath('Old/Notes.pdf', 'New/Notes.pdf');
		let renameFinished = false;
		const rename = store.renamePdfPath('Old/Notes.pdf', 'New/Notes.pdf').then(() => {
			renameFinished = true;
		});
		await Promise.resolve();
		expect(renameFinished).toBe(false);

		releaseWrite();
		expect(await inFlight).toBe(true);
		await rename;
		expect(sessions.peek('Old/Notes.pdf')).toBeNull();
		expect(sessions.get('New/Notes.pdf').path).toBe('New/Notes.pdf');
		expect(fs.files['Old/Notes.pdf.jot.json']).toBeUndefined();

		await store.flush('New/Notes.pdf');
		expect(fs.files['New/Notes.pdf.jot.json']).toContain('#112233');
	});

	it('re-schedules a pending local save under the new PDF path', async () => {
		const fs = makeFs({ 'Old/Notes.pdf.jot.json': validPayload });
		const strokes = new StrokeStore();
		strokes.setForKey('New/Notes.pdf::1', [
			{ points: [{ x: 0.1, y: 0.1, pressure: 0.5 }], color: '#00f', width: 0.005, tool: 'pen' },
		]);
		const store = new SidecarStore(fs.adapter, strokes);
		store.scheduleSave('Old/Notes.pdf');

		await store.renamePdfPath('Old/Notes.pdf', 'New/Notes.pdf');

		expect(store.hasPendingSave('Old/Notes.pdf')).toBe(false);
		expect(store.hasPendingSave('New/Notes.pdf')).toBe(true);
		await vi.advanceTimersByTimeAsync(750);
		expect(fs.files['New/Notes.pdf.jot.json']).toContain('#00f');
	});
});

describe('SidecarStore.isOwnRecentSave', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns false for an unknown path', () => {
		const fs = makeFs();
		const store = new SidecarStore(fs.adapter, new StrokeStore());
		expect(store.isOwnRecentSave('unknown.jot.json')).toBe(false);
	});

	it('returns true for a path saved within the suppression window', async () => {
		const fs = makeFs();
		const strokes = new StrokeStore();
		strokes.setForKey('a.pdf::1', [
			{ points: [{ x: 0, y: 0, pressure: 0.5 }], color: '#000', width: 0.005, tool: 'pen' },
		]);
		const store = new SidecarStore(fs.adapter, strokes);
		store.scheduleSave('a.pdf');
		await store.flush('a.pdf');
		expect(store.isOwnRecentSave('a.pdf.jot.json')).toBe(true);
	});

	it('returns false once the suppression window has elapsed', async () => {
		const fs = makeFs();
		const strokes = new StrokeStore();
		strokes.setForKey('a.pdf::1', [
			{ points: [{ x: 0, y: 0, pressure: 0.5 }], color: '#000', width: 0.005, tool: 'pen' },
		]);
		const store = new SidecarStore(fs.adapter, strokes);
		store.scheduleSave('a.pdf');
		await store.flush('a.pdf');
		vi.advanceTimersByTime(1600);
		expect(store.isOwnRecentSave('a.pdf.jot.json')).toBe(false);
	});

	it('consumes the entry on the first true return so the next call is false', async () => {
		const fs = makeFs();
		const strokes = new StrokeStore();
		strokes.setForKey('a.pdf::1', [
			{ points: [{ x: 0, y: 0, pressure: 0.5 }], color: '#000', width: 0.005, tool: 'pen' },
		]);
		const store = new SidecarStore(fs.adapter, strokes);
		store.scheduleSave('a.pdf');
		await store.flush('a.pdf');
		expect(store.isOwnRecentSave('a.pdf.jot.json')).toBe(true);
		expect(store.isOwnRecentSave('a.pdf.jot.json')).toBe(false);
	});
});

describe('SidecarStore guarded discard', () => {
	it('refuses destructive cleanup if the sidecar changed after the merge baseline was captured', async () => {
		const fs = makeFs({ 'a.pdf.jot.json': validPayload });
		const strokes = new StrokeStore();
		const store = new SidecarStore(fs.adapter, strokes);
		expect(await store.load('a.pdf')).toBe('loaded');
		const baseline = store.captureBaseline('a.pdf');

		const remote = JSON.stringify({
			version: JOT_FORMAT_VERSION,
			pages: {
				'1': [
					{ points: [{ x: 0.7, y: 0.7, pressure: 0.5 }], color: '#ff0000', width: 0.005, tool: 'pen' },
				],
			},
		});
		fs.files['a.pdf.jot.json'] = remote;

		await expect(store.discardIfBaselineUnchanged('a.pdf', baseline)).rejects.toThrow(
			'authoritative file changed',
		);
		expect(fs.files['a.pdf.jot.json']).toBe(remote);
	});

	it('preserves a synced replacement that arrives after the verified baseline is quarantined', async () => {
		const fs = makeFs({ 'a.pdf.jot.json': validPayload });
		const store = new SidecarStore(fs.adapter, new StrokeStore());
		expect(await store.load('a.pdf')).toBe('loaded');
		const baseline = store.captureBaseline('a.pdf');
		const remote = JSON.stringify({ version: JOT_FORMAT_VERSION, pages: { '2': [] } });
		const originalRename = vi.mocked(fs.adapter.rename).getMockImplementation()!;
		let injected = false;
		vi.mocked(fs.adapter.rename).mockImplementation(async (oldPath: string, newPath: string) => {
			await originalRename(oldPath, newPath);
			if (!injected && oldPath === 'a.pdf.jot.json' && newPath.includes('.jot-backup-')) {
				injected = true;
				fs.files['a.pdf.jot.json'] = remote;
			}
		});

		await store.discardIfBaselineUnchanged('a.pdf', baseline);

		expect(fs.files['a.pdf.jot.json']).toBe(remote);
	});

	it('removes the sidecar only when it still matches the captured baseline', async () => {
		const fs = makeFs({ 'a.pdf.jot.json': validPayload });
		const store = new SidecarStore(fs.adapter, new StrokeStore());
		expect(await store.load('a.pdf')).toBe('loaded');
		const baseline = store.captureBaseline('a.pdf');

		await store.discardIfBaselineUnchanged('a.pdf', baseline);

		expect(fs.files['a.pdf.jot.json']).toBeUndefined();
	});

});

describe('SidecarStore.discard', () => {
	it('removes the sidecar file when it exists', async () => {
		const fs = makeFs({ 'a.pdf.jot.json': validPayload });
		const store = new SidecarStore(fs.adapter, new StrokeStore());
		await store.discard('a.pdf');
		expect(fs.files['a.pdf.jot.json']).toBeUndefined();
	});

	it('refuses to discard a sidecar that changed after its clean baseline was loaded', async () => {
		const fs = makeFs({ 'a.pdf.jot.json': validPayload });
		const store = new SidecarStore(fs.adapter, new StrokeStore());
		expect(await store.load('a.pdf')).toBe('loaded');
		const remote = JSON.stringify({ version: JOT_FORMAT_VERSION, pages: { '3': [] } });
		fs.files['a.pdf.jot.json'] = remote;

		await expect(store.discard('a.pdf')).rejects.toThrow('authoritative file changed');
		expect(fs.files['a.pdf.jot.json']).toBe(remote);
	});

	it('refuses to discard authoritative data when a dirty flush fails', async () => {
		vi.useFakeTimers();
		const fs = makeFs({ 'a.pdf.jot.json': validPayload });
		const strokes = new StrokeStore();
		strokes.setForKey('a.pdf::1', [
			{ points: [{ x: 0.4, y: 0.4, pressure: 0.5 }], color: '#444444', width: 0.005, tool: 'pen' },
		]);
		const store = new SidecarStore(fs.adapter, strokes);
		vi.mocked(fs.adapter.write).mockRejectedValueOnce(new Error('disk full'));
		store.scheduleSave('a.pdf');

		await expect(store.discard('a.pdf')).rejects.toThrow('failed to save');
		expect(fs.files['a.pdf.jot.json']).toBe(validPayload);
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it('is a no-op when the sidecar file does not exist', async () => {
		const fs = makeFs();
		const store = new SidecarStore(fs.adapter, new StrokeStore());
		await store.discard('a.pdf');
		expect(fs.adapter.remove).not.toHaveBeenCalled();
	});
});

describe('SidecarStore persistence-domain isolation', () => {
	it('never flushes a dirty notebook session through the PDF sidecar adapter', async () => {
		const fs = makeFs();
		const sessions = new DocumentSessionManager();
		const notebook = sessions.get('Lecture.jot');
		notebook.beginLoad();
		notebook.completeLoad();
		notebook.markDirty();
		const store = new SidecarStore(fs.adapter, new StrokeStore(), sessions);

		expect(await store.flushAll()).toBe(true);
		expect(fs.files['Lecture.jot.jot.json']).toBeUndefined();
		expect(notebook.isDirty).toBe(true);
	});

});

describe('SidecarStore.flushAll', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('does not schedule retries after shutdown if the final sidecar flush fails', async () => {
		const fs = makeFs();
		const strokes = new StrokeStore();
		strokes.setForKey('a.pdf::1', [
			{ points: [{ x: 0.2, y: 0.2, pressure: 0.5 }], color: '#333333', width: 0.005, tool: 'pen' },
		]);
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.mocked(fs.adapter.write).mockRejectedValue(new Error('disk full'));
		const store = new SidecarStore(fs.adapter, strokes);
		store.scheduleSave('a.pdf');

		expect(await store.shutdown()).toBe(false);
		const writesAfterShutdown = vi.mocked(fs.adapter.write).mock.calls.length;
		await vi.advanceTimersByTimeAsync(5000);

		expect(vi.mocked(fs.adapter.write).mock.calls.length).toBe(writesAfterShutdown);
		expect(store.hasPendingSave('a.pdf')).toBe(true);
		error.mockRestore();
	});

	it('flushes every dirty scheduled document instead of discarding work', async () => {
		const fs = makeFs();
		const strokes = new StrokeStore();
		strokes.setForKey('a.pdf::1', [
			{ points: [{ x: 0, y: 0, pressure: 0.5 }], color: '#000', width: 0.005, tool: 'pen' },
		]);
		const store = new SidecarStore(fs.adapter, strokes);
		store.scheduleSave('a.pdf');
		store.scheduleSave('b.pdf');

		expect(await store.flushAll()).toBe(true);
		expect(fs.files['a.pdf.jot.json']).toContain('"pages"');
		expect(fs.files['b.pdf.jot.json']).toContain('"pages"');
		expect(store.hasPendingSave('a.pdf')).toBe(false);
		expect(store.hasPendingSave('b.pdf')).toBe(false);
	});
});
