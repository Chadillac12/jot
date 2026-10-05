export type DocumentSessionState =
	| 'unloaded'
	| 'loading'
	| 'clean'
	| 'dirty'
	| 'saving'
	| 'error'
	| 'conflict';

export interface DocumentSessionSnapshot {
	path: string;
	state: DocumentSessionState;
	revision: number;
	persistedRevision: number;
	lastError: string | null;
}

export class DocumentSession {
	private stateValue: DocumentSessionState = 'unloaded';
	private revisionValue = 0;
	private persistedRevisionValue = 0;
	private lastErrorValue: string | null = null;

	constructor(private pathValue: string) {}

	get path(): string {
		return this.pathValue;
	}

	get state(): DocumentSessionState {
		return this.stateValue;
	}

	get revision(): number {
		return this.revisionValue;
	}

	get persistedRevision(): number {
		return this.persistedRevisionValue;
	}

	get isDirty(): boolean {
		return this.revisionValue !== this.persistedRevisionValue ||
			this.stateValue === 'dirty' ||
			this.stateValue === 'saving' ||
			this.stateValue === 'error' ||
			this.stateValue === 'conflict';
	}

	get canReloadFromDisk(): boolean {
		return !this.isDirty && this.stateValue !== 'loading';
	}

	beginLoad(): boolean {
		if (!this.canReloadFromDisk && this.stateValue !== 'unloaded') return false;
		this.stateValue = 'loading';
		this.lastErrorValue = null;
		return true;
	}

	completeLoad(): void {
		this.stateValue = 'clean';
		this.persistedRevisionValue = this.revisionValue;
		this.lastErrorValue = null;
	}

	markDirty(): number {
		this.revisionValue += 1;
		this.stateValue = 'dirty';
		this.lastErrorValue = null;
		return this.revisionValue;
	}

	beginSave(): number | null {
		if (!this.isDirty) return null;
		this.stateValue = 'saving';
		this.lastErrorValue = null;
		return this.revisionValue;
	}

	completeSave(savedRevision: number): void {
		this.persistedRevisionValue = Math.max(this.persistedRevisionValue, savedRevision);
		this.lastErrorValue = null;
		this.stateValue =
			this.persistedRevisionValue === this.revisionValue ? 'clean' : 'dirty';
	}

	failSave(error: unknown): void {
		this.lastErrorValue = error instanceof Error ? error.message : String(error);
		this.stateValue = 'error';
	}

	markConflict(message: string): void {
		this.lastErrorValue = message;
		this.stateValue = 'conflict';
	}

	resolveConflictKeepLocal(): void {
		this.stateValue = 'dirty';
		this.lastErrorValue = null;
	}

	rename(newPath: string): void {
		this.pathValue = newPath;
	}

	snapshot(): DocumentSessionSnapshot {
		return {
			path: this.pathValue,
			state: this.stateValue,
			revision: this.revisionValue,
			persistedRevision: this.persistedRevisionValue,
			lastError: this.lastErrorValue,
		};
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
		const existing = this.sessions.get(oldPath);
		if (!existing) return this.get(newPath);
		this.sessions.delete(oldPath);
		existing.rename(newPath);
		this.sessions.set(newPath, existing);
		return existing;
	}

	dirtySessions(): DocumentSession[] {
		return [...this.sessions.values()].filter((session) => session.isDirty);
	}

	drop(path: string): void {
		this.sessions.delete(path);
	}
}
