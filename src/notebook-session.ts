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

export type NotebookSessionChange = 'ink' | 'structure' | 'reload' | 'rename' | 'save-error' | 'conflict';

export class NotebookExternalConflictError extends Error {
	constructor(readonly externalData: string) {
		super('Notebook changed on disk while local handwriting was unsaved.');
		this.name = 'NotebookExternalConflictError';
	}
}

export type NotebookSaveWriter = (expectedData: string, nextData: string) => Promise<void>;

export class NotebookDocumentSession {
	readonly strokes = new StrokeStore();
	readonly history = new UndoHistory();
	private noteValue: JotNoteFile = createJotNote();
	private rawDataValue = '';
	private loadErrorValue: string | null = null;
	private persistedDataValue = '';
	private conflictDataValue: string | null = null;
	private listeners = new Set<(
		change: NotebookSessionChange,
		key?: string,
		source?: object,
	) => void>();
	private saveChain: Promise<boolean> = Promise.resolve(true);

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
		// A second view commonly receives the same bytes that this shared session
		// already loaded. Treat that as an idempotent attach, not a disk reload
		// that clears shared undo history.
		if (
			this.stateSession.state !== 'unloaded' &&
			data === this.persistedDataValue
		) {
			if (this.loadErrorValue) return 'protected';
			if (this.stateSession.state === 'conflict') return 'conflict';
			return 'loaded';
		}

		if (this.stateSession.isDirty) {
			if (data === this.persistedDataValue || data === this.serialize()) return 'loaded';
			this.conflictDataValue = data;
			this.stateSession.markConflict(
				'Notebook changed on disk while local handwriting was unsaved.',
			);
			this.emit('conflict');
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
		this.conflictDataValue = null;
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

	markDirty(change: NotebookSessionChange = 'ink', key?: string, source?: object): void {
		if (this.loadErrorValue) return;
		this.stateSession.markDirty();
		this.emit(change, key, source);
	}

	async save(writer: NotebookSaveWriter): Promise<boolean> {
		const previous = this.saveChain;
		const current = previous.then(
			() => this.performSave(writer),
			() => this.performSave(writer),
		);
		this.saveChain = current;
		try {
			return await current;
		} finally {
			if (this.saveChain === current) this.saveChain = Promise.resolve(true);
		}
	}

	private async performSave(writer: NotebookSaveWriter): Promise<boolean> {
		if (this.loadErrorValue || this.stateSession.state === 'conflict') return false;
		const revision = this.stateSession.beginSave();
		if (revision === null) return true;
		const serialized = this.serialize();
		const expectedData = this.persistedDataValue;
		try {
			await writer(expectedData, serialized);
			this.persistedDataValue = serialized;
			this.conflictDataValue = null;
			this.rawDataValue = serialized;
			this.stateSession.completeSave(revision);
			return true;
		} catch (error) {
			if (error instanceof NotebookExternalConflictError) {
				this.conflictDataValue = error.externalData;
				this.stateSession.markConflict(error.message);
				this.emit('conflict');
				return false;
			}
			this.stateSession.failSave(error);
			this.emit('save-error');
			return false;
		}
	}

	resolveConflictKeepLocal(): void {
		if (this.conflictDataValue !== null) {
			// Treat the exact external bytes that triggered the conflict as the new
			// compare-and-swap baseline while retaining the local in-memory model.
			this.persistedDataValue = this.conflictDataValue;
		}
		this.conflictDataValue = null;
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

	subscribe(
		listener: (change: NotebookSessionChange, key?: string, source?: object) => void,
	): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(change: NotebookSessionChange, key?: string, source?: object): void {
		for (const listener of this.listeners) listener(change, key, source);
	}
}

export class NotebookSessionManager {
	private notebooks = new Map<string, NotebookDocumentSession>();
	private refCounts = new Map<string, number>();

	constructor(private sessions: DocumentSessionManager) {}

	get(path: string): NotebookDocumentSession {
		let session = this.notebooks.get(path);
		if (!session) {
			session = new NotebookDocumentSession(this.sessions.get(path), this.sessions);
			this.notebooks.set(path, session);
		}
		return session;
	}

	peek(path: string): NotebookDocumentSession | null {
		return this.notebooks.get(path) ?? null;
	}

	acquire(path: string): NotebookDocumentSession {
		const session = this.get(path);
		this.refCounts.set(path, (this.refCounts.get(path) ?? 0) + 1);
		return session;
	}

	release(session: NotebookDocumentSession): void {
		const path = session.path;
		if (this.notebooks.get(path) !== session) return;
		const next = Math.max(0, (this.refCounts.get(path) ?? 0) - 1);
		if (next === 0) this.refCounts.delete(path);
		else this.refCounts.set(path, next);
		this.dropIfUnused(path);
	}

	dropIfUnused(path: string): boolean {
		const session = this.notebooks.get(path);
		if (!session || (this.refCounts.get(path) ?? 0) > 0 || session.state.isDirty) return false;
		this.drop(path);
		return true;
	}

	rename(oldPath: string, newPath: string): NotebookDocumentSession {
		const existing = this.notebooks.get(oldPath);
		if (!existing) return this.notebooks.get(newPath) ?? this.get(newPath);
		if (oldPath === newPath) return existing;
		const destination = this.notebooks.get(newPath);
		if (destination && destination !== existing) {
			if ((this.refCounts.get(newPath) ?? 0) > 0 || destination.state.isDirty) return existing;
			this.drop(newPath);
		}
		const refs = this.refCounts.get(oldPath) ?? 0;
		this.notebooks.delete(oldPath);
		this.refCounts.delete(oldPath);
		existing.rename(newPath);
		this.notebooks.set(newPath, existing);
		if (refs > 0) this.refCounts.set(newPath, refs);
		return existing;
	}

	all(): NotebookDocumentSession[] {
		return [...this.notebooks.values()];
	}

	drop(path: string): void {
		this.refCounts.delete(path);
		this.notebooks.delete(path);
		this.sessions.drop(path);
	}
}
