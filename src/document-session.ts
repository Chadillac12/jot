export type DocumentSessionState =
	| 'unloaded'
	| 'loading'
	| 'clean'
	| 'dirty'
	| 'saving'
	| 'conflict'
	| 'error';

export interface SaveToken {
	path: string;
	revision: number;
}

export class DocumentSession {
	private currentPath: string;
	private currentState: DocumentSessionState = 'unloaded';
	private revision = 0;
	private persistedRevision = 0;
	private lastError: Error | null = null;

	constructor(path: string) {
		this.currentPath = path;
	}

	get path(): string {
		return this.currentPath;
	}

	get state(): DocumentSessionState {
		return this.currentState;
	}

	get error(): Error | null {
		return this.lastError;
	}

	get isDirty(): boolean {
		return this.revision !== this.persistedRevision;
	}

	get currentRevision(): number {
		return this.revision;
	}

	get savedRevision(): number {
		return this.persistedRevision;
	}

	canReload(): boolean {
		return (
			!this.isDirty &&
			this.currentState !== 'saving' &&
			this.currentState !== 'conflict'
		);
	}

	beginLoad(): boolean {
		if (!this.canReload()) return false;
		this.currentState = 'loading';
		this.lastError = null;
		return true;
	}

	completeLoad(): void {
		this.revision = 0;
		this.persistedRevision = 0;
		this.currentState = 'clean';
		this.lastError = null;
	}

	failLoad(error: unknown): void {
		this.currentState = this.isDirty ? 'dirty' : 'error';
		this.lastError = toError(error);
	}

	markDirty(): number {
		this.revision += 1;
		if (this.currentState !== 'conflict') this.currentState = 'dirty';
		return this.revision;
	}

	beginSave(): SaveToken | null {
		if (!this.isDirty) {
			if (this.currentState !== 'conflict') this.currentState = 'clean';
			return null;
		}
		if (this.currentState === 'conflict') return null;
		this.currentState = 'saving';
		this.lastError = null;
		return { path: this.currentPath, revision: this.revision };
	}

	completeSave(token: SaveToken): void {
		if (token.path !== this.currentPath) return;
		this.persistedRevision = Math.max(this.persistedRevision, token.revision);
		this.currentState = this.isDirty ? 'dirty' : 'clean';
		this.lastError = null;
	}

	failSave(token: SaveToken, error: unknown): void {
		if (token.path !== this.currentPath) return;
		this.currentState = 'error';
		this.lastError = toError(error);
	}

	markConflict(error?: unknown): void {
		this.currentState = 'conflict';
		this.lastError = error === undefined ? null : toError(error);
	}

	resolveConflictKeepLocal(): void {
		this.currentState = this.isDirty ? 'dirty' : 'clean';
		this.lastError = null;
	}

	rename(newPath: string): void {
		this.currentPath = newPath;
	}
}

export class DocumentSessionManager {
	private sessions = new Map<string, DocumentSession>();

	get(path: string): DocumentSession {
		let session = this.sessions.get(path);
		if (!session) {
			session = new DocumentSession(path);
			this.sessions.set(path, session);
		}
		return session;
	}

	peek(path: string): DocumentSession | null {
		return this.sessions.get(path) ?? null;
	}

	rename(oldPath: string, newPath: string): DocumentSession {
		const session = this.get(oldPath);
		this.sessions.delete(oldPath);
		session.rename(newPath);
		this.sessions.set(newPath, session);
		return session;
	}

	remove(path: string): void {
		this.sessions.delete(path);
	}

	all(): DocumentSession[] {
		return [...this.sessions.values()];
	}
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}
