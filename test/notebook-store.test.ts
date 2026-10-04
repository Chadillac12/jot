/* @vitest-environment happy-dom */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/unbound-method */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('obsidian', () => ({
	TFile: class TFile {
		path: string;
		constructor(path: string) {
			this.path = path;
		}
	},
}));

import { TFile, type Vault } from 'obsidian';
import { DocumentSessionManager } from '../src/document-session';
import { createJotNote, serializeJotNote } from '../src/jot-note-file';
import { NotebookSessionManager } from '../src/notebook-session';
import { NotebookStore } from '../src/notebook-store';

function makeVault(path = 'Lecture.jot') {
	const file = new (TFile as unknown as new (path: string) => TFile)(path);
	const data = new Map<string, string>([[path, serializeJotNote(createJotNote())]]);
	const vault = {
		getAbstractFileByPath: vi.fn((lookup: string) => (file.path === lookup ? file : null)),
		modify: vi.fn(async (target: TFile, text: string) => {
			data.set(target.path, text);
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

	it('persists a shared notebook independently of any view instance', async () => {
		const fs = makeVault();
		const sessions = new NotebookSessionManager(new DocumentSessionManager());
		const session = sessions.get('Lecture.jot');
		expect(session.loadFromText(fs.data.get('Lecture.jot')!)).toBe('loaded');
		session.setPaperStyle('grid');

		const store = new NotebookStore(fs.vault, sessions);
		store.scheduleSave('Lecture.jot');
		await vi.advanceTimersByTimeAsync(750);

		expect(fs.vault.modify).toHaveBeenCalledTimes(1);
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
		const originalModify = vi.mocked(fs.vault.modify).getMockImplementation()!;
		vi.mocked(fs.vault.modify)
			.mockRejectedValueOnce(new Error('disk full'))
			.mockImplementation(originalModify);

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
		const originalModify = vi.mocked(fs.vault.modify).getMockImplementation()!;
		vi.mocked(fs.vault.modify).mockImplementationOnce(async (file: TFile, text: string) => {
			await gate;
			await originalModify(file, text);
		});

		const store = new NotebookStore(fs.vault, sessions);
		store.scheduleSave('Old/Lecture.jot');
		const save = store.flush('Old/Lecture.jot');
		await Promise.resolve();

		// Obsidian has already renamed the underlying TFile by the time onRename
		// is delivered to the view.
		fs.data.delete('Old/Lecture.jot');
		(fs.file as any).path = 'New/Lecture.jot';

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
