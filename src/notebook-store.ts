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
}

export class NotebookStore {
	constructor(
		private adapter: DataAdapter,
		private sessions: DocumentSessionManager,
		private callbacks: NotebookStoreCallbacks = {},
	) {}

	async save(session: NotebookDocumentSession): Promise<boolean> {
		const previousState = session.state;
		const revision = session.beginSave();
		if (revision === null) return false;
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
			return true;
		} catch (error) {
			const typed = error instanceof Error ? error : new Error(String(error));
			session.saveFailed(typed);
			this.callbacks.onSaveError?.(session.path, typed);
			throw typed;
		}
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
