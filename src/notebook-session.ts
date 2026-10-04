import type { DocumentSession, DocumentSessionManager, SaveToken } from './document-session';
import { documentPageKey } from './jot-file';
import {
	createJotNote,
	nextPageId,
	parseJotNoteTextResult,
	serializeJotNote,
	type JotNoteFile,
	type JotNoteParseResult,
	type JotPaperStyle,
} from './jot-note-file';
import { StrokeStore } from './stroke-store';
import { UndoHistory } from './undo';

export type NotebookLoadStatus = 'loaded' | 'unchanged' | 'conflict' | 'error';
export type NotebookSessionEvent = 'load' | 'ink' | 'paper' | 'structure' | 'state';

export class NotebookSession {
	readonly strokes = new StrokeStore();
	readonly history = new UndoHistory();
	readonly lifecycle: DocumentSession;

	private noteValue: JotNoteFile = createJotNote();
	private rawDataValue = '';
	private loadErrorValue: string | null = null;
	private externalConflictDataValue: string | null = null;
	private expectedPersistedTextValue: string | null = null;
	private listeners = new Set<(event: NotebookSessionEvent) => void>();
	private inkNotificationQueued = false;

	constructor(
		path: string,
		documentSessions: DocumentSessionManager,
	) {
		this.lifecycle = documentSessions.get(path);
	}

	get path(): string {
		return this.lifecycle.path;
	}

	get note(): JotNoteFile {
		return this.noteValue;
	}

	get rawData(): string {
		return this.rawDataValue;
	}

	get loadError(): string | null {
		return this.loadErrorValue;
	}

	get externalConflictData(): string | null {
		return this.externalConflictDataValue;
	}

	loadFromText(text: string): NotebookLoadStatus {
		if (
			this.lifecycle.state !== 'unloaded' &&
			(text === this.rawDataValue || text === this.expectedPersistedTextValue)
		) {
			return 'unchanged';
		}
		if (!this.lifecycle.canReload()) {
			if (text === this.rawDataValue) return 'unchanged';
			this.externalConflictDataValue = text;
			this.lifecycle.markConflict(
				new Error('External notebook data changed while local edits were dirty'),
			);
			this.notify('state');
			return 'conflict';
		}
		if (!this.lifecycle.beginLoad()) return 'conflict';

		const parsed = parseJotNoteTextResult(text);
		if (!parsed.ok) {
			this.rawDataValue = text;
			this.loadErrorValue = parsed.message;
			this.lifecycle.failLoad(new Error(parsed.message));
			this.notify('load');
			return 'error';
		}

		this.applyParsed(parsed, text);
		return 'loaded';
	}

	serialize(): string {
		if (this.loadErrorValue) return this.rawDataValue;
		const snapshot: JotNoteFile = {
			...this.noteValue,
			pages: this.noteValue.pages.map((page) => ({
				...page,
				strokes: [...this.strokes.forKey(documentPageKey(this.path, page.id))],
			})),
		};
		return serializeJotNote(snapshot);
	}

	markDirty(): number {
		const revision = this.lifecycle.markDirty();
		this.queueInkNotification();
		return revision;
	}

	prepareSave(): { token: SaveToken; text: string } | null {
		const token = this.lifecycle.beginSave();
		if (!token) return null;
		const text = this.serialize();
		this.expectedPersistedTextValue = text;
		return { token, text };
	}

	completeSave(token: SaveToken, persistedText: string): void {
		this.rawDataValue = persistedText;
		if (this.expectedPersistedTextValue === persistedText) {
			this.expectedPersistedTextValue = null;
		}
		this.lifecycle.completeSave(token);
		this.notify('state');
	}

	failSave(token: SaveToken, error: unknown): void {
		this.expectedPersistedTextValue = null;
		this.lifecycle.failSave(token, error);
		this.notify('state');
	}

	resolveConflictKeepLocal(): void {
		this.externalConflictDataValue = null;
		this.lifecycle.resolveConflictKeepLocal();
		this.notify('state');
	}

	setPaperStyle(style: JotPaperStyle): void {
		if (this.loadErrorValue || this.noteValue.paper === style) return;
		this.noteValue = { ...this.noteValue, paper: style };
		this.lifecycle.markDirty();
		this.notify('paper');
	}

	addPage(): string | null {
		if (this.loadErrorValue) return null;
		const id = nextPageId(this.noteValue.pages);
		this.noteValue = {
			...this.noteValue,
			pages: [
				...this.noteValue.pages,
				{
					id,
					width: 1536,
					height: 2048,
					strokes: [],
				},
			],
		};
		this.lifecycle.markDirty();
		this.notify('structure');
		return id;
	}

	rekeyForRename(oldPath: string, newPath: string): void {
		if (oldPath === newPath) return;
		this.strokes.rekeyDocumentPath(oldPath, newPath);
		this.history.rekeyPath(oldPath, newPath);
		this.notify('structure');
	}

	subscribe(listener: (event: NotebookSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	notify(event: NotebookSessionEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	private queueInkNotification(): void {
		if (this.inkNotificationQueued) return;
		this.inkNotificationQueued = true;
		queueMicrotask(() => {
			this.inkNotificationQueued = false;
			this.notify('ink');
		});
	}

	private applyParsed(parsed: Extract<JotNoteParseResult, { ok: true }>, text: string): void {
		this.noteValue = parsed.note;
		this.rawDataValue = text;
		this.loadErrorValue = null;
		this.externalConflictDataValue = null;
		this.expectedPersistedTextValue = null;
		this.strokes.clearFor(this.path);
		for (const page of parsed.note.pages) {
			this.strokes.setForKey(documentPageKey(this.path, page.id), [...page.strokes]);
		}
		this.history.dropPath(this.path);
		this.lifecycle.completeLoad();
		this.notify('load');
	}
}

export class NotebookSessionManager {
	private sessions = new Map<string, NotebookSession>();

	constructor(private documentSessions: DocumentSessionManager) {}

	get(path: string): NotebookSession {
		let session = this.sessions.get(path);
		if (!session) {
			session = new NotebookSession(path, this.documentSessions);
			this.sessions.set(path, session);
		}
		return session;
	}

	rename(oldPath: string, newPath: string): NotebookSession {
		const session = this.get(oldPath);
		this.sessions.delete(oldPath);
		session.rekeyForRename(oldPath, newPath);
		this.documentSessions.rename(oldPath, newPath);
		this.sessions.set(newPath, session);
		return session;
	}

	remove(path: string): void {
		this.sessions.delete(path);
		this.documentSessions.remove(path);
	}
}
