import {
	createJotNote,
	parseJotNoteTextResult,
	serializeJotNote,
	type JotNoteFile,
	type JotPaperStyle,
} from './jot-note-file';
import { documentPageKey } from './jot-file';
import { StrokeStore } from './stroke-store';
import { UndoHistory } from './undo';

export type DocumentKind = 'pdf' | 'notebook';
export type DocumentSessionState =
	| 'unloaded'
	| 'loading'
	| 'clean'
	| 'dirty'
	| 'saving'
	| 'load-error'
	| 'save-error'
	| 'conflict';

export type SessionChange = 'state' | 'ink' | 'structure' | 'rename';

export interface SessionSnapshot {
	path: string;
	kind: DocumentKind;
	state: DocumentSessionState;
	revision: number;
	persistedRevision: number;
	lastError: string | null;
	conflictReason: string | null;
}

type SessionListener = (change: SessionChange, snapshot: SessionSnapshot) => void;

export class DocumentSession {
	private _state: DocumentSessionState = 'unloaded';
	private _revision = 0;
	private _persistedRevision = 0;
	private _saveRevision: number | null = null;
	private _lastError: string | null = null;
	private _conflictReason: string | null = null;
	private listeners = new Set<SessionListener>();

	constructor(
		public path: string,
		public readonly kind: DocumentKind,
		public readonly strokes: StrokeStore,
		public readonly history: UndoHistory,
	) {}

	get state(): DocumentSessionState {
		return this._state;
	}

	get revision(): number {
		return this._revision;
	}

	get persistedRevision(): number {
		return this._persistedRevision;
	}

	get lastError(): string | null {
		return this._lastError;
	}

	get conflictReason(): string | null {
		return this._conflictReason;
	}

	get isDirty(): boolean {
		return (
			this._revision !== this._persistedRevision ||
			this._state === 'dirty' ||
			this._state === 'saving' ||
			this._state === 'save-error' ||
			this._state === 'conflict'
		);
	}

	get canReload(): boolean {
		return this._state === 'unloaded' || this._state === 'clean' || this._state === 'load-error';
	}

	beginLoad(): boolean {
		if (!this.canReload) return false;
		this._state = 'loading';
		this.emit('state');
		return true;
	}

	completeLoad(): void {
		this._revision = 0;
		this._persistedRevision = 0;
		this._saveRevision = null;
		this._lastError = null;
		this._conflictReason = null;
		this._state = 'clean';
		this.emit('state');
	}

	loadFailed(error: unknown): void {
		this._lastError = errorMessage(error);
		this._state = 'load-error';
		this.emit('state');
	}

	markDirty(change: Exclude<SessionChange, 'state' | 'rename'> = 'ink'): number {
		this._revision += 1;
		if (this._state !== 'conflict') this._state = 'dirty';
		this._lastError = null;
		this.emit(change);
		return this._revision;
	}

	beginSave(): number | null {
		if (this._state === 'saving') return null;
		if (!this.isDirty && this._state === 'clean') return null;
		if (this._state === 'loading' || this._state === 'unloaded') return null;
		this._saveRevision = this._revision;
		this._state = 'saving';
		this._lastError = null;
		this.emit('state');
		return this._saveRevision;
	}

	saveSucceeded(savedRevision: number): void {
		this._persistedRevision = Math.max(this._persistedRevision, savedRevision);
		this._saveRevision = null;
		this._lastError = null;
		this._conflictReason = null;
		this._state = this._revision === savedRevision ? 'clean' : 'dirty';
		this.emit('state');
	}

	saveFailed(error: unknown): void {
		this._saveRevision = null;
		this._lastError = errorMessage(error);
		this._state = 'save-error';
		this.emit('state');
	}

	markConflict(reason: string): void {
		this._conflictReason = reason;
		this._state = 'conflict';
		this.emit('state');
	}

	rename(newPath: string): void {
		if (this.path === newPath) return;
		const oldPath = this.path;
		this.strokes.rekeyDocumentPath(oldPath, newPath);
		this.history.rekeyPath(oldPath, newPath);
		this.path = newPath;
		this.emit('rename');
	}

	subscribe(listener: SessionListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	snapshot(): SessionSnapshot {
		return {
			path: this.path,
			kind: this.kind,
			state: this._state,
			revision: this._revision,
			persistedRevision: this._persistedRevision,
			lastError: this._lastError,
			conflictReason: this._conflictReason,
		};
	}

	protected emit(change: SessionChange): void {
		const snapshot = this.snapshot();
		for (const listener of this.listeners) listener(change, snapshot);
	}
}

export class NotebookDocumentSession extends DocumentSession {
	note: JotNoteFile = createJotNote();
	rawData = '';
	loadError: string | null = null;
	initialized = false;

	constructor(
		path: string,
		strokes: StrokeStore,
		history: UndoHistory,
	) {
		super(path, 'notebook', strokes, history);
	}

	loadText(data: string): 'loaded' | 'unchanged' | 'conflict' | 'invalid' {
		if (this.initialized && data === this.rawData) return 'unchanged';
		if (!this.beginLoad()) {
			if (data !== this.rawData) {
				this.markConflict('The notebook changed on disk while local edits were unsaved.');
				return 'conflict';
			}
			return 'unchanged';
		}

		const parsed = parseJotNoteTextResult(data);
		if (!parsed.ok) {
			this.rawData = data;
			this.loadError = parsed.message;
			this.initialized = true;
			this.markConflict(parsed.message);
			return 'invalid';
		}

		this.loadError = null;
		this.rawData = data;
		this.note = parsed.note;
		this.initialized = true;
		this.history.dropPath(this.path);
		this.strokes.clearFor(this.path);
		for (const page of this.note.pages) {
			this.strokes.setForKey(documentPageKey(this.path, page.id), [...page.strokes]);
		}
		this.completeLoad();
		return 'loaded';
	}

	serializeCurrent(): string {
		const note: JotNoteFile = {
			...this.note,
			pages: this.note.pages.map((page) => ({
				...page,
				strokes: [...this.strokes.forKey(documentPageKey(this.path, page.id))],
			})),
		};
		return serializeJotNote(note);
	}

	notebookSaveSucceeded(savedRevision: number, serialized: string): void {
		this.rawData = serialized;
		this.dataFromCurrentModel();
		this.saveSucceeded(savedRevision);
	}

	setPaperStyle(style: JotPaperStyle): void {
		if (this.note.paper === style) return;
		this.note = { ...this.note, paper: style };
		this.markDirty('structure');
	}

	setNote(note: JotNoteFile): void {
		this.note = note;
		this.markDirty('structure');
	}

	private dataFromCurrentModel(): void {
		this.note = {
			...this.note,
			pages: this.note.pages.map((page) => ({
				...page,
				strokes: [...this.strokes.forKey(documentPageKey(this.path, page.id))],
			})),
		};
	}
}

export class DocumentSessionManager {
	readonly strokes = new StrokeStore();
	readonly history = new UndoHistory();
	private sessions = new Map<string, DocumentSession>();

	pdf(path: string): DocumentSession {
		const existing = this.sessions.get(path);
		if (existing) return existing;
		const session = new DocumentSession(path, 'pdf', this.strokes, this.history);
		this.sessions.set(path, session);
		return session;
	}

	notebook(path: string): NotebookDocumentSession {
		const existing = this.sessions.get(path);
		if (existing instanceof NotebookDocumentSession) return existing;
		if (existing) throw new Error(`Jot document kind mismatch for ${path}`);
		const session = new NotebookDocumentSession(path, this.strokes, this.history);
		this.sessions.set(path, session);
		return session;
	}

	get(path: string): DocumentSession | null {
		return this.sessions.get(path) ?? null;
	}

	rename(oldPath: string, newPath: string): DocumentSession | null {
		const session = this.sessions.get(oldPath);
		if (!session) return null;
		if (this.sessions.has(newPath)) {
			throw new Error(`Jot session already exists for destination ${newPath}`);
		}
		this.sessions.delete(oldPath);
		session.rename(newPath);
		this.sessions.set(newPath, session);
		return session;
	}

	all(): DocumentSession[] {
		return [...this.sessions.values()];
	}

	drop(path: string): void {
		this.sessions.delete(path);
		this.strokes.clearFor(path);
		this.history.dropPath(path);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
