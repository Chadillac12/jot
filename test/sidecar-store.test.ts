/* @vitest-environment happy-dom */
import type { DataAdapter } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentSessionManager } from '../src/document-session';
import { JOT_FORMAT_VERSION } from '../src/jot-file';
import { SidecarStore } from '../src/sidecar-store';

interface FileSystem {
	files: Record<string, string>;
	adapter: DataAdapter;
	failNextWrite: () => void;
	failNextRename: () => void;
}

function makeFs(initial: Record<string, string> = {}): FileSystem {
	const files: Record<string, string> = { ...initial };
	let failWrite = false;
	let failRename = false;
	const adapter = {
		exists: vi.fn(async (path: string) => path in files),
		read: vi.fn(async (path: string) => {
			if (!(path in files)) throw new Error(`missing ${path}`);
			return files[path]!;
		}),
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
			if (failRename) {
				failRename = false;
				throw new Error('injected rename failure');
			}
			if (!(oldPath in files)) throw new Error(`missing ${oldPath}`);
			files[newPath] = files[oldPath]!;
			delete files[oldPath];
		}),
	} as unknown as DataAdapter;
	return {
		files,
		adapter,
		failNextWrite: () => {
			failWrite = true;
		},
		failNextRename: () => {
			failRename = true;
		},
	};
}

function stroke(color = '#000000') {
	return {
		points: [{ x: 0.1, y: 0.2, pressure: 0.5 }],
		color,
		width: 0.005,
		tool: 'pen' as const,
	};
}

function payload(color = '#000000'): string {
	return JSON.stringify({
		version: JOT_FORMAT_VERSION,
		pages: { '1': [stroke(color)] },
	});
}

async function loadClean(
	store: SidecarStore,
	path = 'a.pdf',
): Promise<void> {
	await store.load(path);
}

describe('SidecarStore session-safe load', () => {
	it('loads a valid sidecar into a clean session', async () => {
		const fs = makeFs({ 'a.pdf.jot.json': payload('#112233') });
		const sessions = new DocumentSessionManager();
		const store = new SidecarStore(fs.adapter, sessions);

		expect(await store.load('a.pdf')).toBe('loaded');
		expect(sessions.strokes.forPage('a.pdf', 1)[0]?.color).toBe('#112233');
		expect(sessions.pdf('a.pdf').state).toBe('clean');
	});

	it('loads a missing sidecar as a clean empty document', async () => {
		const fs = makeFs();
		const sessions = new DocumentSessionManager();
		const store = new SidecarStore(fs.adapter, sessions);

		expect(await store.load('a.pdf')).toBe('missing');
		expect(sessions.strokes.hasFor('a.pdf')).toBe(false);
		expect(sessions.pdf('a.pdf').state).toBe('clean');
	});

	it('never replaces dirty local ink during a reload', async () => {
		const fs = makeFs({ 'a.pdf.jot.json': payload('#ff0000') });
		const sessions = new DocumentSessionManager();
		const store = new SidecarStore(fs.adapter, sessions);
		await loadClean(store);
		sessions.strokes.setForKey('a.pdf::1', [stroke('#0000ff')]);
		sessions.pdf('a.pdf').markDirty();

		fs.files['a.pdf.jot.json'] = payload('#00ff00');
		expect(await store.load('a.pdf')).toBe('skipped-dirty');
		expect(sessions.strokes.forPage('a.pdf', 1)[0]?.color).toBe('#0000ff');
	});

	it('marks an invalid external sidecar as a conflict without clearing memory', async () => {
		const fs = makeFs({ 'a.pdf.jot.json': payload('#112233') });
		const sessions = new DocumentSessionManager();
		const store = new SidecarStore(fs.adapter, sessions);
		await loadClean(store);
		sessions.strokes.setForKey('a.pdf::1', [stroke('#445566')]);

		fs.files['a.pdf.jot.json'] = '{broken';
		expect(await store.load('a.pdf')).toBe('protected');
		expect(sessions.pdf('a.pdf').state).toBe('conflict');
		expect(sessions.strokes.forPage('a.pdf', 1)[0]?.color).toBe('#445566');
	});
});

describe('SidecarStore transactional save and retry', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('writes an empty valid payload instead of destructively deleting the sidecar', async () => {
		const fs = makeFs({ 'a.pdf.jot.json': payload() });
		const sessions = new DocumentSessionManager();
		const store = new SidecarStore(fs.adapter, sessions);
		await loadClean(store);
		sessions.strokes.clearFor('a.pdf');
		store.scheduleSave('a.pdf');

		await vi.advanceTimersByTimeAsync(750);

		const written = JSON.parse(fs.files['a.pdf.jot.json']!) as {
			version: number;
			pages: Record<string, unknown>;
		};
		expect(written.version).toBe(JOT_FORMAT_VERSION);
		expect(written.pages).toEqual({});
		expect(sessions.pdf('a.pdf').state).toBe('clean');
	});

	it('keeps the session dirty and observable after an injected write failure', async () => {
		const fs = makeFs();
		const sessions = new DocumentSessionManager();
		const onSaveError = vi.fn();
		const store = new SidecarStore(fs.adapter, sessions, { onSaveError });
		await loadClean(store);
		sessions.strokes.setForKey('a.pdf::1', [stroke('#123456')]);
		fs.failNextWrite();

		store.scheduleSave('a.pdf');
		await vi.advanceTimersByTimeAsync(750);

		expect(sessions.pdf('a.pdf').state).toBe('save-error');
		expect(sessions.pdf('a.pdf').isDirty).toBe(true);
		expect(onSaveError).toHaveBeenCalledTimes(1);
	});

	it('automatically retries a failed save and returns to clean', async () => {
		const fs = makeFs();
		const sessions = new DocumentSessionManager();
		const store = new SidecarStore(fs.adapter, sessions);
		await loadClean(store);
		sessions.strokes.setForKey('a.pdf::1', [stroke('#123456')]);
		fs.failNextWrite();

		store.scheduleSave('a.pdf');
		await vi.advanceTimersByTimeAsync(750);
		expect(sessions.pdf('a.pdf').state).toBe('save-error');

		await vi.advanceTimersByTimeAsync(2000);
		expect(sessions.pdf('a.pdf').state).toBe('clean');
		expect(fs.files['a.pdf.jot.json']).toContain('#123456');
	});

	it('rolls back the authoritative sidecar if commit rename fails', async () => {
		const original = payload('#111111');
		const fs = makeFs({ 'a.pdf.jot.json': original });
		const sessions = new DocumentSessionManager();
		const store = new SidecarStore(fs.adapter, sessions);
		await loadClean(store);
		sessions.strokes.setForKey('a.pdf::1', [stroke('#222222')]);
		sessions.pdf('a.pdf').markDirty();
		fs.failNextRename();

		await expect(store.flush('a.pdf')).rejects.toThrow('injected rename failure');
		expect(fs.files['a.pdf.jot.json']).toBe(original);
		expect(sessions.pdf('a.pdf').state).toBe('save-error');
	});

	it('flushAll persists dirty sessions instead of cancelling pending work', async () => {
		const fs = makeFs();
		const sessions = new DocumentSessionManager();
		const store = new SidecarStore(fs.adapter, sessions);
		await store.load('a.pdf');
		sessions.strokes.setForKey('a.pdf::1', [stroke('#abcdef')]);
		store.scheduleSave('a.pdf');

		expect(store.hasPendingSave('a.pdf')).toBe(true);
		expect(await store.flushAll()).toEqual([]);
		expect(fs.files['a.pdf.jot.json']).toContain('#abcdef');
		expect(sessions.pdf('a.pdf').state).toBe('clean');
	});
});

describe('SidecarStore conflicts and renames', () => {
	it('preserves the external sidecar before local dirty state wins', async () => {
		const remote = payload('#ff0000');
		const fs = makeFs({ 'a.pdf.jot.json': remote });
		const sessions = new DocumentSessionManager();
		const store = new SidecarStore(fs.adapter, sessions);
		await loadClean(store);
		sessions.strokes.setForKey('a.pdf::1', [stroke('#0000ff')]);
		sessions.pdf('a.pdf').markDirty();

		const conflictPath = await store.preserveExternalConflictAndFlushLocal('a.pdf');

		expect(conflictPath).not.toBeNull();
		expect(conflictPath ? fs.files[conflictPath] : undefined).toBe(remote);
		expect(fs.files['a.pdf.jot.json']).toContain('#0000ff');
		expect(sessions.pdf('a.pdf').state).toBe('clean');
	});

	it('backs up an unreadable original before replacing it with verified local data', async () => {
		const fs = makeFs({ 'a.pdf.jot.json': '{broken' });
		const sessions = new DocumentSessionManager();
		const store = new SidecarStore(fs.adapter, sessions);
		expect(await store.load('a.pdf')).toBe('protected');
		sessions.strokes.setForKey('a.pdf::1', [stroke('#00ff00')]);
		sessions.pdf('a.pdf').markDirty();

		await store.flush('a.pdf');

		const recovery = Object.keys(fs.files).find((path) =>
			path.startsWith('a.pdf.jot.json.recovery-'),
		);
		expect(recovery).toBeDefined();
		expect(recovery ? fs.files[recovery] : undefined).toBe('{broken');
		expect(fs.files['a.pdf.jot.json']).toContain('#00ff00');
	});

	it('flushes dirty ink before moving a PDF sidecar and session path', async () => {
		const fs = makeFs({ 'Old/a.pdf.jot.json': payload('#111111') });
		const sessions = new DocumentSessionManager();
		const store = new SidecarStore(fs.adapter, sessions);
		await store.load('Old/a.pdf');
		sessions.strokes.setForKey('Old/a.pdf::1', [stroke('#222222')]);
		sessions.pdf('Old/a.pdf').markDirty();

		await store.renamePdfPath('Old/a.pdf', 'New/a.pdf');

		expect(sessions.get('Old/a.pdf')).toBeNull();
		expect(sessions.pdf('New/a.pdf').state).toBe('clean');
		expect(sessions.strokes.forKey('New/a.pdf::1')[0]?.color).toBe('#222222');
		expect(fs.files['Old/a.pdf.jot.json']).toBeUndefined();
		expect(fs.files['New/a.pdf.jot.json']).toContain('#222222');
	});

	it('preserves a destination sidecar conflict before replacing it on rename', async () => {
		const source = payload('#111111');
		const destination = payload('#999999');
		const fs = makeFs({
			'Old/a.pdf.jot.json': source,
			'New/a.pdf.jot.json': destination,
		});
		const sessions = new DocumentSessionManager();
		const store = new SidecarStore(fs.adapter, sessions);
		await store.load('Old/a.pdf');

		await store.renamePdfPath('Old/a.pdf', 'New/a.pdf');

		const conflict = Object.keys(fs.files).find((path) =>
			path.startsWith('New/a.pdf.jot.json.conflict-'),
		);
		expect(conflict).toBeDefined();
		expect(conflict ? fs.files[conflict] : undefined).toBe(destination);
		expect(fs.files['New/a.pdf.jot.json']).toBe(source);
	});
});
