import type { DocumentSession, DocumentSessionManager } from './document-session';
import { documentPageKey } from './jot-file';
import {
	createJotNote,
	parseJotNoteTextResult,
	serializeJotNote,
	type JotNoteFile,
} from './jot-note-file';
import { StrokeStore } from './stroke-store';
import { UndoHistory } from './undo';

export type NotebookSessionChange = 'ink' | 'structure' | 'reload' | 'rename';

export class NotebookDocumentSession {
	readonly strokes = new StrokeStore();
	readonly history = new UndoHistory();
	private noteValue: JotNoteFile = createJotNote();
	private rawDataValue = '';
	private loadErrorValue: string | null = null;
	private persistedDataValue = '';
	private listeners = new Set<(change: NotebookSessionChange) => void>();

	constructor(
		private stateSession: DocumentSession,
		private sessions: DocumentSessionManager,
	) {}

	get path(): string {
		return this.stateSession.path;
	}

	get note(): JotNoteFile {
		return this.noteValue;
	}

	set note(note: JotNoteFile) {
		this.noteValue = note;
	}

	get loadError(): string | null {
		return this.loadErrorValue;
	}

	get rawData(): string {
		return this.rawDataValue;
	}

	get state(): DocumentSession {
		return this.stateSession;
	}

	load(data: string): 'loaded' | 'protected' | 'conflict' {
		if (this.stateSession.isDirty) {
			if (data === this.persistedDataValue || data === this.serialize()) return 'loaded';
			this.stateSession.markConflict(
				'Notebook changed on disk while local handwriting was unsaved.',
			);
			return 'conflict';
		}

		if (!this.stateSession.beginLoad() && this.stateSession.state !== 'unloaded') {
			return 'conflict';
		}

		const parsed = parseJotNoteTextResult(data);
		this.rawDataValue = data;
		if (!parsed.ok) {
			this.loadErrorValue = parsed.message;
			this.persistedDataValue = data;
			this.stateSession.completeLoad();
			return 'protected';
		}

		this.loadErrorValue = null;
		this.noteValue = parsed.note;
		this.strokes.clearFor(this.path);
		for (const page of parsed.note.pages) {
			this.strokes.setForKey(documentPageKey(this.path, page.id), [...page.strokes]);
		}
		this.history.dropPath(this.path);
		this.persistedDataValue = data;
		this.stateSession.completeLoad();
		this.emit('reload');
		return 'loaded';
	}

	serialize(): string {
		if (this.loadErrorValue) return this.rawDataValue;
		this.noteValue = {
			...this.noteValue,
			pages: this.noteValue.pages.map((page) => ({
				...page,
				strokes: [...this.strokes.forKey(documentPageKey(this.path, page.id))],
			})),
		};
		this.rawDataValue = serializeJotNote(this.noteValue);
		return this.rawDataValue;
	}

	markDirty(change: NotebookSessionChange = 'ink'): void {
		if (this.loadErrorValue) return;
		this.stateSession.markDirty();
		this.emit(change);
	}

	beginSave(): number | null {
		if (this.loadErrorValue || this.stateSession.state === 'conflict') return null;
		return this.stateSession.beginSave();
	}

	completeSave(revision: number, data: string): void {
		this.persistedDataValue = data;
		this.rawDataValue = data;
		this.stateSession.completeSave(revision);
	}

	failSave(error: unknown): void {
		this.stateSession.failSave(error);
	}

	resolveConflictKeepLocal(): void {
		this.stateSession.resolveConflictKeepLocal();
	}

	rename(newPath: string): void {
		const oldPath = this.path;
		if (oldPath === newPath) return;
		this.strokes.rekeyDocumentPath(oldPath, newPath);
		this.history.rekeyPath(oldPath, newPath);
		this.stateSession = this.sessions.rename(oldPath, newPath);
		this.emit('rename');
	}

	subscribe(listener: (change: NotebookSessionChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(change: NotebookSessionChange): void {
		for (const listener of this.listeners) listener(change);
	}
}

export class NotebookSessionManager {
	private notebooks = new Map<string, NotebookDocumentSession>();

	constructor(private sessions: DocumentSessionManager) {}

	get(path: string): NotebookDocumentSession {
		let session = this.notebooks.get(path);
		if (!session) {
			session = new NotebookDocumentSession(this.sessions.get(path), this.sessions);
			this.notebooks.set(path, session);
		}
		return session;
	}

	rename(oldPath: string, newPath: string): NotebookDocumentSession {
		const existing = this.notebooks.get(oldPath);
		if (!existing) return this.get(newPath);
		this.notebooks.delete(oldPath);
		existing.rename(newPath);
		this.notebooks.set(newPath, existing);
		return existing;
	}

	drop(path: string): void {
		this.notebooks.delete(path);
		this.sessions.drop(path);
	}
}
