/* @vitest-environment happy-dom */
import type { DataAdapter } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { DocumentSessionManager } from '../src/document-session';
import { NotebookStore } from '../src/notebook-store';

function notebookText(): string {
	return JSON.stringify({
		version: 1,
		type: 'notebook',
		paper: 'ruled',
		pages: [{ id: 'page-1', width: 1536, height: 2048, strokes: [] }],
	});
}

function makeAdapter() {
	const files: Record<string, string> = {};
	let failWrite = false;
	const adapter = {
		exists: vi.fn(async (path: string) => path in files),
		read: vi.fn(async (path: string) => {
			if (!(path in files)) throw new Error(`missing ${path}`);
			return files[path]!;
		}),
		write: vi.fn(async (path: string, value: string) => {
			if (failWrite) {
				failWrite = false;
				throw new Error('injected notebook write failure');
			}
			files[path] = value;
		}),
		rename: vi.fn(async (oldPath: string, newPath: string) => {
			if (!(oldPath in files)) throw new Error(`missing ${oldPath}`);
			files[newPath] = files[oldPath]!;
			delete files[oldPath];
		}),
		remove: vi.fn(async (path: string) => {
			delete files[path];
		}),
	} as unknown as DataAdapter;
	return {
		files,
		adapter,
		failNextWrite: () => {
			failWrite = true;
		},
	};
}

describe('NotebookStore shared-session persistence', () => {
	it('persists ink from the shared model regardless of which view requested the session', async () => {
		const fs = makeAdapter();
		const sessions = new DocumentSessionManager();
		const a = sessions.notebook('Lecture.jot');
		const b = sessions.notebook('Lecture.jot');
		expect(a).toBe(b);
		a.loadText(notebookText());
		sessions.strokes.setForKey('Lecture.jot::page-1', [
			{
				points: [{ x: 0.2, y: 0.3, pressure: 0.6 }],
				color: '#123456',
				width: 0.0025,
				tool: 'pen',
			},
		]);
		a.markDirty();

		const store = new NotebookStore(fs.adapter, sessions);
		expect(await store.save(b)).toBe(true);

		expect(fs.files['Lecture.jot']).toContain('#123456');
		expect(a.state).toBe('clean');
		expect(b.state).toBe('clean');
	});

	it('collapses concurrent save attempts into one in-flight transaction', async () => {
		const sessions = new DocumentSessionManager();
		const session = sessions.notebook('Lecture.jot');
		session.loadText(notebookText());
		session.markDirty();

		const files: Record<string, string> = {};
		let releaseWrite!: () => void;
		const writeGate = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		let firstWrite = true;
		const adapter = {
			exists: vi.fn(async (path: string) => path in files),
			read: vi.fn(async (path: string) => files[path] ?? ''),
			write: vi.fn(async (path: string, value: string) => {
				if (firstWrite) {
					firstWrite = false;
					await writeGate;
				}
				files[path] = value;
			}),
			rename: vi.fn(async (oldPath: string, newPath: string) => {
				files[newPath] = files[oldPath]!;
				delete files[oldPath];
			}),
			remove: vi.fn(async (path: string) => {
				delete files[path];
			}),
		} as unknown as DataAdapter;
		const store = new NotebookStore(adapter, sessions);

		const first = store.save(session);
		const second = store.save(session);
		expect(session.state).toBe('saving');

		releaseWrite();
		expect(await first).toBe(true);
		expect(await second).toBe(true);
		expect(session.state).toBe('clean');
	});

	it('keeps a failed notebook save dirty and allows a later retry', async () => {
		const fs = makeAdapter();
		const sessions = new DocumentSessionManager();
		const session = sessions.notebook('Lecture.jot');
		session.loadText(notebookText());
		session.markDirty();
		const onSaveError = vi.fn();
		const store = new NotebookStore(fs.adapter, sessions, { onSaveError });
		fs.failNextWrite();

		await expect(store.save(session)).rejects.toThrow('injected notebook write failure');
		expect(session.state).toBe('save-error');
		expect(session.isDirty).toBe(true);
		expect(onSaveError).toHaveBeenCalledTimes(1);

		expect(await store.save(session)).toBe(true);
		expect(session.state).toBe('clean');
	});
});


describe('NotebookStore concurrent revision handling', () => {
	it('persists a newer notebook edit that arrives while an earlier revision is in flight', async () => {
		const sessions = new DocumentSessionManager();
		const session = sessions.notebook('Lecture.jot');
		session.loadText(notebookText());
		session.setPaperStyle('grid');

		const files: Record<string, string> = {};
		let releaseWrite!: () => void;
		let signalStarted!: () => void;
		const writeGate = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		const writeStarted = new Promise<void>((resolve) => {
			signalStarted = resolve;
		});
		let blockFirstTempWrite = true;
		const adapter = {
			exists: vi.fn(async (path: string) => path in files),
			read: vi.fn(async (path: string) => {
				const value = files[path];
				if (value === undefined) throw new Error(`missing ${path}`);
				return value;
			}),
			write: vi.fn(async (path: string, value: string) => {
				if (blockFirstTempWrite && path.includes('.jot-tmp-')) {
					blockFirstTempWrite = false;
					signalStarted();
					await writeGate;
				}
				files[path] = value;
			}),
			rename: vi.fn(async (oldPath: string, newPath: string) => {
				const value = files[oldPath];
				if (value === undefined) throw new Error(`missing ${oldPath}`);
				files[newPath] = value;
				delete files[oldPath];
			}),
			remove: vi.fn(async (path: string) => {
				delete files[path];
			}),
		} as unknown as DataAdapter;
		const store = new NotebookStore(adapter, sessions);

		const firstSave = store.save(session);
		await writeStarted;
		session.setPaperStyle('dot');
		releaseWrite();
		await firstSave;

		expect(files['Lecture.jot']).toContain('"paper": "dot"');
		expect(session.state).toBe('clean');
		expect(session.revision).toBe(session.persistedRevision);
	});
});

describe('NotebookStore lifecycle flushing', () => {
	it('flushAll persists every dirty notebook session', async () => {
		const fs = makeAdapter();
		const sessions = new DocumentSessionManager();
		const first = sessions.notebook('One.jot');
		const second = sessions.notebook('Two.jot');
		first.loadText(notebookText());
		second.loadText(notebookText());
		first.setPaperStyle('grid');
		second.setPaperStyle('dot');
		const store = new NotebookStore(fs.adapter, sessions);

		expect(await store.flushAll()).toEqual([]);

		expect(fs.files['One.jot']).toContain('"paper": "grid"');
		expect(fs.files['Two.jot']).toContain('"paper": "dot"');
		expect(first.state).toBe('clean');
		expect(second.state).toBe('clean');
	});
});

describe('NotebookStore conflict preservation', () => {
	it('does not save an invalid conflict with no local edits', async () => {
		const fs = makeAdapter();
		fs.files['Broken.jot'] = '{broken';
		const sessions = new DocumentSessionManager();
		const session = sessions.notebook('Broken.jot');
		expect(session.loadText('{broken')).toBe('invalid');
		const store = new NotebookStore(fs.adapter, sessions);

		expect(await store.save(session)).toBe(false);
		expect(fs.files['Broken.jot']).toBe('{broken');
		expect(session.state).toBe('conflict');
	});

	it('preserves the external notebook before locally dirty conflict resolution', async () => {
		const fs = makeAdapter();
		const original = notebookText();
		fs.files['Lecture.jot'] = original;
		const sessions = new DocumentSessionManager();
		const session = sessions.notebook('Lecture.jot');
		session.loadText(original);
		session.setPaperStyle('grid');
		const external = original.replace('"ruled"', '"dot"');
		fs.files['Lecture.jot'] = external;
		expect(session.loadText(external)).toBe('conflict');
		const onConflictPreserved = vi.fn();
		const store = new NotebookStore(fs.adapter, sessions, { onConflictPreserved });

		expect(await store.save(session)).toBe(true);

		const conflictPath = Object.keys(fs.files).find((path) =>
			path.startsWith('Lecture.jot.conflict-'),
		);
		expect(conflictPath).toBeDefined();
		expect(conflictPath ? fs.files[conflictPath] : undefined).toBe(external);
		expect(fs.files['Lecture.jot']).toContain('"paper": "grid"');
		expect(onConflictPreserved).toHaveBeenCalledTimes(1);
	});
});


describe('NotebookStore duplicate rename notifications', () => {
	it('coalesces duplicate rename migrations onto the same shared session', async () => {
		const fs = makeAdapter();
		const sessions = new DocumentSessionManager();
		const session = sessions.notebook('Old.jot');
		session.loadText(notebookText());
		fs.files['New.jot'] = notebookText();
		const store = new NotebookStore(fs.adapter, sessions);

		const [first, second] = await Promise.all([
			store.renameSession('Old.jot', 'New.jot'),
			store.renameSession('Old.jot', 'New.jot'),
		]);

		expect(first).toBe(session);
		expect(second).toBe(session);
		expect(sessions.get('Old.jot')).toBeNull();
		expect(sessions.notebook('New.jot')).toBe(session);
	});
});

describe('NotebookStore rename serialization', () => {
	it('moves the authoritative session after an in-flight old-path save and commits current data at the new path', async () => {
		const sessions = new DocumentSessionManager();
		const session = sessions.notebook('Old.jot');
		const original = notebookText();
		session.loadText(original);
		session.setPaperStyle('grid');

		const files: Record<string, string> = { 'New.jot': original };
		let releaseWrite!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		let gateFirstOldTempWrite = true;
		const adapter = {
			exists: vi.fn(async (path: string) => path in files),
			read: vi.fn(async (path: string) => {
				const value = files[path];
				if (value === undefined) throw new Error(`missing ${path}`);
				return value;
			}),
			write: vi.fn(async (path: string, value: string) => {
				if (gateFirstOldTempWrite && path.startsWith('Old.jot.jot-tmp-')) {
					gateFirstOldTempWrite = false;
					await gate;
				}
				files[path] = value;
			}),
			rename: vi.fn(async (oldPath: string, newPath: string) => {
				const value = files[oldPath];
				if (value === undefined) throw new Error(`missing ${oldPath}`);
				files[newPath] = value;
				delete files[oldPath];
			}),
			remove: vi.fn(async (path: string) => {
				delete files[path];
			}),
		} as unknown as DataAdapter;
		const store = new NotebookStore(adapter, sessions);

		const firstSave = store.save(session);
		const rename = store.renameSession('Old.jot', 'New.jot');
		releaseWrite();
		await firstSave;
		await rename;

		expect(sessions.get('Old.jot')).toBeNull();
		expect(sessions.notebook('New.jot')).toBe(session);
		expect(session.state).toBe('clean');
		expect(files['New.jot']).toContain('"paper": "grid"');
		expect(files['Old.jot']).toBeUndefined();
	});
});
