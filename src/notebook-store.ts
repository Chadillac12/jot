import type { DataAdapter } from 'obsidian';
import {
	DocumentSessionManager,
	type NotebookDocumentSession,
} from './document-session';
import { parseJotNoteTextResult } from './jot-note-file';
import { transactionalWriteText } from './transactional-write';

export interface NotebookStoreCallbacks {
	onSaveError?: (path: string, error: Error) => void;
	onSaveRecovered?: (path: string) => void;
	onConflictPreserved?: (path: string, conflictPath: string) => void;
}

export class NotebookStore {
	private inFlight = new Map<string, Promise<boolean>>();

	constructor(
		private adapter: DataAdapter,
		private sessions: DocumentSessionManager,
		private callbacks: NotebookStoreCallbacks = {},
	) {}

	async save(session: NotebookDocumentSession): Promise<boolean> {
		const existing = this.inFlight.get(session.path);
		if (existing) return existing;

		const task = this.runSaveLoop(session);
		this.inFlight.set(session.path, task);
		try {
			return await task;
		} finally {
			if (this.inFlight.get(session.path) === task) this.inFlight.delete(session.path);
		}
	}

	private async runSaveLoop(session: NotebookDocumentSession): Promise<boolean> {
		let savedAny = false;
		while (session.isDirty) {
			const previousState = session.state;
			if (previousState === 'conflict') {
				const conflictPath = await this.preserveExternalConflict(session.path);
				if (conflictPath) this.callbacks.onConflictPreserved?.(session.path, conflictPath);
			}
			const revision = session.beginSave();
			if (revision === null) break;
			const serialized = session.serializeCurrent();

			try {
				await transactionalWriteText(
					this.adapter,
					session.path,
					serialized,
					validateNotebookText,
				);
				session.notebookSaveSucceeded(revision, serialized);
				if (previousState === 'save-error') this.callbacks.onSaveRecovered?.(session.path);
				savedAny = true;
			} catch (error) {
				const typed = error instanceof Error ? error : new Error(String(error));
				session.saveFailed(typed);
				this.callbacks.onSaveError?.(session.path, typed);
				throw typed;
			}
		}
		return savedAny;
	}

	private async preserveExternalConflict(path: string): Promise<string | null> {
		if (!(await this.adapter.exists(path))) return null;
		const current = await this.adapter.read(path);
		const conflictPath = `${path}.conflict-${Date.now()}.jot`;
		await this.adapter.write(conflictPath, current);
		if ((await this.adapter.read(conflictPath)) !== current) {
			throw new Error(`Notebook conflict-copy verification failed for ${path}`);
		}
		return conflictPath;
	}

	async flushAll(): Promise<Array<{ path: string; error: Error }>> {
		const failures: Array<{ path: string; error: Error }> = [];
		for (const session of this.sessions.all()) {
			if (session.kind !== 'notebook' || !session.isDirty) continue;
			try {
				await this.save(session as NotebookDocumentSession);
			} catch (error) {
				failures.push({
					path: session.path,
					error: error instanceof Error ? error : new Error(String(error)),
				});
			}
		}
		return failures;
	}
}

function validateNotebookText(text: string): void {
	const parsed = parseJotNoteTextResult(text);
	if (!parsed.ok) throw new Error(`Notebook transaction validation failed: ${parsed.message}`);
}
