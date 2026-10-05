/* @vitest-environment happy-dom */
/* eslint-disable @typescript-eslint/unbound-method */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import type { Vault } from 'obsidian';
import { DocumentSessionManager } from '../src/document-session';
import { createJotNote, serializeJotNote } from '../src/jot-note-file';
import { NotebookSessionManager } from '../src/notebook-session';
import { NotebookStore } from '../src/notebook-store';

function makeVault(path = 'Lecture.jot') {
	const file = { path, extension: 'jot' };
	const data = new Map<string, string>([[path, serializeJotNote(createJotNote())]]);
	const vault = {
		getAbstractFileByPath: vi.fn((lookup: string) => (file.path === lookup ? file : null)),
		process: vi.fn(async (target: { path: string }, fn: (current: string) => string) => {
			const current = data.get(target.path) ?? '';
			const next = fn(current);
			data.set(target.path, next);
			return next;
		}),
	} as unknown as Vault;
	return { vault, file, data };
}

describe('NotebookStore', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});


	it('does not schedule a retry timer after shutdown begins', async () => {
		const fs = makeVault();
		const baseline = fs.data.get('Lecture.jot')!;
		const sessions = new NotebookSessionManager(new DocumentSessionManager());
		const session = sessions.get('Lecture.jot');
		expect(session.loadFromText(baseline)).toBe('loaded');
		session.setPaperStyle('grid');
		const store = new NotebookStore(fs.vault, sessions);
		store.scheduleSave('Lecture.jot');
		store.beginShutdown();
		vi.mocked(fs.vault.process).mockRejectedValueOnce(new Error('suspended'));

		expect(await store.flushAll()).toBe(false);
		const callsAfterFlush = vi.mocked(fs.vault.process).mock.calls.length;
		await vi.advanceTimersByTimeAsync(5000);
		expect(vi.mocked(fs.vault.process).mock.calls.length).toBe(callsAfterFlush);
		expect(fs.data.get('Lecture.jot')).toBe(baseline);
	});

	it('persists a shared notebook independently of any view instance', async () => {
		const fs = makeVault();
		const sessions = new NotebookSessionManager(new DocumentSessionManager());
		const session = sessions.get('Lecture.jot');
		expect(session.loadFromText(fs.data.get('Lecture.jot')!)).toBe('loaded');
		session.setPaperStyle('grid');

		const store = new NotebookStore(fs.vault, sessions);
		store.scheduleSave('Lecture.jot');
		await vi.advanceTimersByTimeAsync(750);

		expect(fs.vault.process).toHaveBeenCalledTimes(1);
		expect(fs.data.get('Lecture.jot')).toContain('"paper": "grid"');
		expect(session.lifecycle.isDirty).toBe(false);
	});

	it('keeps failed notebook data dirty and retries after the view could have closed', async () => {
		const fs = makeVault();
		const sessions = new NotebookSessionManager(new DocumentSessionManager());
		const session = sessions.get('Lecture.jot');
		session.loadFromText(fs.data.get('Lecture.jot')!);
		session.setPaperStyle('dot');
		const onError = vi.fn();
		const originalProcess = vi.mocked(fs.vault.process).getMockImplementation()!;
		vi.mocked(fs.vault.process)
			.mockRejectedValueOnce(new Error('disk full'))
			.mockImplementation(originalProcess);

		const store = new NotebookStore(fs.vault, sessions, onError);
		store.scheduleSave('Lecture.jot');
		await vi.advanceTimersByTimeAsync(750);

		expect(onError).toHaveBeenCalledTimes(1);
		expect(session.lifecycle.isDirty).toBe(true);

		await vi.advanceTimersByTimeAsync(2000);
		expect(fs.data.get('Lecture.jot')).toContain('"paper": "dot"');
		expect(session.lifecycle.isDirty).toBe(false);
	});

	it('flushAll persists dirty notebook sessions during lifecycle transitions', async () => {
		const fs = makeVault();
		const sessions = new NotebookSessionManager(new DocumentSessionManager());
		const session = sessions.get('Lecture.jot');
		session.loadFromText(fs.data.get('Lecture.jot')!);
		session.setPaperStyle('blank');
		const store = new NotebookStore(fs.vault, sessions);
		store.scheduleSave('Lecture.jot');

		expect(await store.flushAll()).toBe(true);
		expect(fs.data.get('Lecture.jot')).toContain('"paper": "blank"');
		expect(session.lifecycle.isDirty).toBe(false);
	});

	it('detects an atomic compare-and-swap conflict without overwriting external data', async () => {
		const fs = makeVault();
		const sessions = new NotebookSessionManager(new DocumentSessionManager());
		const session = sessions.get('Lecture.jot');
		session.loadFromText(fs.data.get('Lecture.jot')!);
		session.setPaperStyle('grid');

		const remote = createJotNote();
		remote.paper = 'dot';
		const remoteText = serializeJotNote(remote);
		fs.data.set('Lecture.jot', remoteText);
		const onConflict = vi.fn();
		const store = new NotebookStore(fs.vault, sessions, undefined, onConflict);
		store.scheduleSave('Lecture.jot');

		expect(await store.flush('Lecture.jot')).toBe(false);
		expect(fs.data.get('Lecture.jot')).toBe(remoteText);
		expect(session.lifecycle.state).toBe('conflict');
		expect(session.externalConflictData).toBe(remoteText);
		expect(onConflict).toHaveBeenCalledWith('Lecture.jot');
	});

	it('can keep local after preserving a CAS conflict without rediscovering it', async () => {
		const fs = makeVault();
		const sessions = new NotebookSessionManager(new DocumentSessionManager());
		const session = sessions.get('Lecture.jot');
		session.loadFromText(fs.data.get('Lecture.jot')!);
		session.setPaperStyle('grid');

		const remote = createJotNote();
		remote.paper = 'dot';
		const remoteText = serializeJotNote(remote);
		fs.data.set('Lecture.jot', remoteText);
		const store = new NotebookStore(fs.vault, sessions);
		store.scheduleSave('Lecture.jot');
		expect(await store.flush('Lecture.jot')).toBe(false);
		expect(session.lifecycle.state).toBe('conflict');

		// The caller has preserved remoteText to a conflict file at this point.
		session.resolveConflictKeepLocal();
		store.scheduleSave('Lecture.jot');
		expect(await store.flush('Lecture.jot')).toBe(true);

		expect(fs.data.get('Lecture.jot')).toContain('"paper": "grid"');
		expect(session.lifecycle.state).toBe('clean');
		expect(session.externalConflictData).toBeNull();
	});

	it('waits for an in-flight notebook save before re-keying rename ownership', async () => {
		const fs = makeVault('Old/Lecture.jot');
		const documents = new DocumentSessionManager();
		const sessions = new NotebookSessionManager(documents);
		const session = sessions.get('Old/Lecture.jot');
		session.loadFromText(fs.data.get('Old/Lecture.jot')!);
		session.setPaperStyle('grid');

		let releaseModify!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseModify = resolve;
		});
		const originalProcess = vi.mocked(fs.vault.process).getMockImplementation()!;
		vi.mocked(fs.vault.process).mockImplementationOnce(
			async (file, fn) => {
				await gate;
				return originalProcess(file, fn);
			},
		);

		const store = new NotebookStore(fs.vault, sessions);
		store.scheduleSave('Old/Lecture.jot');
		const save = store.flush('Old/Lecture.jot');
		await Promise.resolve();

		// Obsidian has already renamed the underlying TFile by the time onRename
		// is delivered to the view.
		fs.data.set('New/Lecture.jot', fs.data.get('Old/Lecture.jot')!);
		fs.data.delete('Old/Lecture.jot');
		fs.file.path = 'New/Lecture.jot';

		let renameFinished = false;
		const rename = store.rename('Old/Lecture.jot', 'New/Lecture.jot').then(() => {
			renameFinished = true;
		});
		await Promise.resolve();
		expect(renameFinished).toBe(false);

		releaseModify();
		expect(await save).toBe(true);
		await rename;

		expect(documents.peek('Old/Lecture.jot')).toBeNull();
		expect(documents.get('New/Lecture.jot').path).toBe('New/Lecture.jot');
		expect(fs.data.get('New/Lecture.jot')).toContain('"paper": "grid"');
	});
});
