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
		const second = await store.save(session);
		expect(second).toBe(false);
		expect(session.state).toBe('saving');

		releaseWrite();
		expect(await first).toBe(true);
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
