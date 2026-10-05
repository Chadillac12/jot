import type { DataAdapter } from 'obsidian';
import { DocumentSessionManager } from './document-session';
import {
	JOT_FORMAT_VERSION,
	isSupportedVersion,
	jotPathFor,
	parseJotText,
} from './jot-file';
import type { StrokeStore } from './stroke-store';
import {
	TransactionConflictError,
	recoverInterruptedTextWrite,
	transactionalRemoveTextExpected,
	transactionalWriteText,
} from './transactional-write';

const SAVE_DEBOUNCE_MS = 750;
const RETRY_DELAY_MS = 2000;
const SELF_SAVE_SUPPRESS_MS = 1500;
const PLUGIN_LOG = '[jot]';

export type SidecarLoadStatus =
	| 'loaded'
	| 'missing'
	| 'protected'
	| 'dirty'
	| 'error';

export interface TimerHost {
	setTimeout(callback: () => void, delayMs: number): number;
	clearTimeout(id: number): void;
}

const DEFAULT_TIMER_HOST: TimerHost = {
	setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
	clearTimeout: (id) => window.clearTimeout(id),
};

export class SidecarStore {
	private saveTimers = new Map<string, number>();
	private recentSelfSaves = new Map<string, number>();
	private inFlightSaves = new Map<string, Promise<boolean>>();
	private protectedOriginals = new Map<string, string>();
	private persistedBaselines = new Map<string, string | null>();
	private ownedPdfPaths = new Set<string>();
	private shuttingDown = false;

	constructor(
		private adapter: DataAdapter,
		private strokes: StrokeStore,
		private sessions: DocumentSessionManager = new DocumentSessionManager(),
		private onSaveError?: (pdfPath: string, error: Error) => void,
		private timers: TimerHost = DEFAULT_TIMER_HOST,
	) {}

	async load(pdfPath: string): Promise<SidecarLoadStatus> {
		this.ownedPdfPaths.add(pdfPath);
		const session = this.sessions.get(pdfPath);
		const loadRevision = session.currentRevision;
		if (!session.beginLoad()) return 'dirty';

		const path = jotPathFor(pdfPath);
		try {
			await recoverInterruptedTextWrite(this.adapter, path, (candidate) => {
				const parsed = parseJotText(candidate);
				return parsed !== null && isSupportedVersion(parsed.version);
			});
			if (!(await this.adapter.exists(path))) {
				if (!this.loadStillOwnsRevision(session, loadRevision)) return 'dirty';
				this.persistedBaselines.set(pdfPath, null);
				this.protectedOriginals.delete(pdfPath);
				this.strokes.clearFor(pdfPath);
				session.completeLoad();
				return 'missing';
			}

			const text = await this.adapter.read(path);
			const parsed = parseJotText(text);
			if (!parsed) {
				this.persistedBaselines.set(pdfPath, text);
				this.protectedOriginals.set(pdfPath, text);
				const error = new Error(`${path} is invalid`);
				session.failLoad(error);
				console.warn(`${PLUGIN_LOG} ${error.message}; keeping current annotations in memory`);
				return 'protected';
			}
			if (!isSupportedVersion(parsed.version)) {
				this.persistedBaselines.set(pdfPath, text);
				this.protectedOriginals.set(pdfPath, text);
				const error = new Error(`${path} has unknown version ${parsed.version}`);
				session.failLoad(error);
				console.warn(`${PLUGIN_LOG} ${error.message}; keeping current annotations in memory`);
				return 'protected';
			}

			// Disk I/O above is asynchronous. Local Pencil input may have dirtied
			// the session while this load was in flight. A stale load must never
			// replace that newer in-memory revision.
			if (!this.loadStillOwnsRevision(session, loadRevision)) return 'dirty';
			this.persistedBaselines.set(pdfPath, text);
			this.protectedOriginals.delete(pdfPath);
			this.strokes.clearFor(pdfPath);
			this.strokes.populateFromPayload(pdfPath, parsed.pages);
			session.completeLoad();
			return 'loaded';
		} catch (error) {
			session.failLoad(error);
			console.error(`${PLUGIN_LOG} load failed for ${path}:`, error);
			return 'error';
		}
	}

	async save(pdfPath: string): Promise<boolean> {
		const existing = this.inFlightSaves.get(pdfPath);
		if (existing) {
			const priorSucceeded = await existing;
			if (!priorSucceeded) return false;
			return this.sessions.get(pdfPath).isDirty ? this.save(pdfPath) : true;
		}

		const operation = this.performSave(pdfPath);
		this.inFlightSaves.set(pdfPath, operation);
		try {
			return await operation;
		} finally {
			if (this.inFlightSaves.get(pdfPath) === operation) {
				this.inFlightSaves.delete(pdfPath);
			}
		}
	}

	private async performSave(pdfPath: string): Promise<boolean> {
		const session = this.sessions.get(pdfPath);
		const token = session.beginSave();
		if (!token) return !session.isDirty;

		const path = jotPathFor(pdfPath);
		const payload = this.strokes.buildPayload(pdfPath) ?? {
			version: JOT_FORMAT_VERSION,
			pages: {},
		};
		const text = JSON.stringify(payload, null, 2);

		try {
			const protectedText = this.protectedOriginals.get(pdfPath);
			if (protectedText !== undefined) {
				const recoveryPath = `${path}.recovery-${Date.now()}.json`;
				await transactionalWriteText(this.adapter, recoveryPath, protectedText);
			}

			await this.writeWithBaselineProtection(pdfPath, path, text);
			this.protectedOriginals.delete(pdfPath);
			this.recentSelfSaves.set(path, Date.now());
			session.completeSave(token);

			// A new edit may have arrived while the previous revision was in flight.
			if (session.isDirty) this.queueSave(pdfPath, SAVE_DEBOUNCE_MS);
			return true;
		} catch (error) {
			session.failSave(token, error);
			const normalized = error instanceof Error ? error : new Error(String(error));
			console.error(`${PLUGIN_LOG} save failed for ${path}:`, normalized);
			this.onSaveError?.(pdfPath, normalized);
			this.queueSave(pdfPath, RETRY_DELAY_MS);
			return false;
		}
	}

	scheduleSave(pdfPath: string): void {
		this.ownedPdfPaths.add(pdfPath);
		this.sessions.get(pdfPath).markDirty();
		this.queueSave(pdfPath, SAVE_DEBOUNCE_MS);
	}

	async flush(pdfPath: string): Promise<boolean> {
		this.clearTimer(pdfPath);
		const session = this.sessions.get(pdfPath);
		if (!session.isDirty) return true;
		const saved = await this.save(pdfPath);
		if (saved && !session.isDirty) this.clearTimer(pdfPath);
		return saved;
	}

	async flushAll(): Promise<boolean> {
		const paths = new Set<string>([
			...this.saveTimers.keys(),
			...Array.from(this.ownedPdfPaths).filter(
				(path) => this.sessions.peek(path)?.isDirty === true,
			),
		]);
		let allSaved = true;
		for (const path of paths) {
			if (!(await this.flush(path))) allSaved = false;
		}
		return allSaved;
	}

	async shutdown(): Promise<boolean> {
		this.shuttingDown = true;
		return this.flushAll();
	}

	hasPendingSave(pdfPath: string): boolean {
		return this.sessions.get(pdfPath).isDirty || this.saveTimers.has(pdfPath);
	}

	captureBaseline(pdfPath: string): string | null {
		if (!this.persistedBaselines.has(pdfPath)) {
			throw new Error(`No verified sidecar baseline is available for ${pdfPath}`);
		}
		return this.persistedBaselines.get(pdfPath)!;
	}

	async discardIfBaselineUnchanged(
		pdfPath: string,
		expectedBaseline: string | null,
	): Promise<void> {
		const session = this.sessions.get(pdfPath);
		if (session.isDirty) {
			throw new Error(`Cannot discard ${pdfPath} annotations while local ink is dirty`);
		}
		const path = jotPathFor(pdfPath);
		await transactionalRemoveTextExpected(this.adapter, path, expectedBaseline);

		this.protectedOriginals.delete(pdfPath);
		this.persistedBaselines.delete(pdfPath);
		this.ownedPdfPaths.delete(pdfPath);
		this.sessions.remove(pdfPath);
	}

	async preserveExternalConflictAndFlushLocal(pdfPath: string): Promise<string | null> {
		const session = this.sessions.get(pdfPath);
		if (!session.isDirty) return null;

		const sidecarPath = jotPathFor(pdfPath);
		try {
			if (!(await this.adapter.exists(sidecarPath))) return null;
			const remoteText = await this.adapter.read(sidecarPath);
			const conflictPath = `${sidecarPath}.conflict-${Date.now()}.json`;
			await transactionalWriteText(this.adapter, conflictPath, remoteText);
			this.persistedBaselines.set(pdfPath, remoteText);
			session.markConflict();
			session.resolveConflictKeepLocal();
			if (!(await this.flush(pdfPath))) {
				console.error(
					`${PLUGIN_LOG} external conflict was preserved at ${conflictPath}, but local ink still failed to flush for ${sidecarPath}`,
				);
				return null;
			}
			return conflictPath;
		} catch (error) {
			session.markConflict(error);
			console.error(
				`${PLUGIN_LOG} could not preserve external conflict for ${sidecarPath}:`,
				error,
			);
			return null;
		}
	}

	async renamePdfPath(oldPdfPath: string, newPdfPath: string): Promise<void> {
		if (oldPdfPath === newPdfPath) return;

		// A save transaction may already have captured the old-path payload. Let
		// that transaction finish before moving lifecycle/path ownership so its
		// revision token can complete against the path it was issued for.
		const inFlight = this.inFlightSaves.get(oldPdfPath);
		if (inFlight) await inFlight;

		const oldSidecar = jotPathFor(oldPdfPath);
		const newSidecar = jotPathFor(newPdfPath);
		const protectedText = this.protectedOriginals.get(oldPdfPath);
		const hadBaseline = this.persistedBaselines.has(oldPdfPath);
		const previousBaseline = this.persistedBaselines.get(oldPdfPath) ?? null;
		this.persistedBaselines.delete(oldPdfPath);
		if (hadBaseline) this.persistedBaselines.set(newPdfPath, previousBaseline);
		if (protectedText !== undefined) {
			this.protectedOriginals.delete(oldPdfPath);
			this.protectedOriginals.set(newPdfPath, protectedText);
		}

		const hadPending = this.hasPendingSave(oldPdfPath);
		this.clearTimer(oldPdfPath);
		this.ownedPdfPaths.delete(oldPdfPath);
		this.ownedPdfPaths.add(newPdfPath);
		this.sessions.rename(oldPdfPath, newPdfPath);

		try {
			if (await this.adapter.exists(oldSidecar)) {
				const sourceText = await this.adapter.read(oldSidecar);
				let expectedDestination: string | null = null;
				if (await this.adapter.exists(newSidecar)) {
					const destinationText = await this.adapter.read(newSidecar);
					expectedDestination = destinationText;
					const conflictPath = `${newSidecar}.conflict-${Date.now()}.json`;
					await transactionalWriteText(this.adapter, conflictPath, destinationText);
				}
				await transactionalWriteText(
					this.adapter,
					newSidecar,
					sourceText,
					undefined,
					expectedDestination,
				);
				await this.adapter.remove(oldSidecar);
				this.persistedBaselines.set(newPdfPath, sourceText);
			}
			this.recentSelfSaves.delete(oldSidecar);
		} catch (error) {
			console.error(
				`${PLUGIN_LOG} could not move sidecar from ${oldSidecar} to ${newSidecar}:`,
				error,
			);
			this.onSaveError?.(
				newPdfPath,
				error instanceof Error ? error : new Error(String(error)),
			);
		}

		if (hadPending || this.strokes.hasFor(newPdfPath)) {
			if (!this.sessions.get(newPdfPath).isDirty) this.sessions.get(newPdfPath).markDirty();
			this.queueSave(newPdfPath, SAVE_DEBOUNCE_MS);
		}
	}

	isOwnRecentSave(path: string): boolean {
		const writtenAt = this.recentSelfSaves.get(path);
		if (writtenAt === undefined) return false;
		if (Date.now() - writtenAt >= SELF_SAVE_SUPPRESS_MS) return false;
		this.recentSelfSaves.delete(path);
		return true;
	}

	async discard(pdfPath: string): Promise<void> {
		if (!(await this.flush(pdfPath))) {
			throw new Error(`Cannot discard ${pdfPath} annotations because dirty data failed to save`);
		}
		const path = jotPathFor(pdfPath);
		this.protectedOriginals.delete(pdfPath);
		this.persistedBaselines.delete(pdfPath);
		if (await this.adapter.exists(path)) await this.adapter.remove(path);
		this.ownedPdfPaths.delete(pdfPath);
		this.sessions.remove(pdfPath);
	}

	private async writeWithBaselineProtection(
		pdfPath: string,
		path: string,
		text: string,
	): Promise<void> {
		let expected = this.persistedBaselines.has(pdfPath)
			? this.persistedBaselines.get(pdfPath)!
			: await this.readTextOrNull(path);

		if (!this.persistedBaselines.has(pdfPath)) {
			// A save without a prior load should still be conservative. Treat the
			// current disk contents as the baseline rather than assuming ownership.
			this.persistedBaselines.set(pdfPath, expected);
		}

		const validate = (candidate: string): boolean => {
			const parsed = parseJotText(candidate);
			return parsed !== null && isSupportedVersion(parsed.version);
		};

		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await transactionalWriteText(this.adapter, path, text, validate, expected);
				this.persistedBaselines.set(pdfPath, text);
				return;
			} catch (error) {
				if (!(error instanceof TransactionConflictError)) throw error;

				const remoteText = await this.readTextOrNull(path);
				if (remoteText === text) {
					this.persistedBaselines.set(pdfPath, text);
					return;
				}

				if (remoteText !== null && remoteText !== expected) {
					const conflictPath = `${path}.conflict-${Date.now()}-${attempt + 1}.json`;
					await transactionalWriteText(this.adapter, conflictPath, remoteText);
					console.warn(
						`${PLUGIN_LOG} simultaneous sidecar edit preserved at ${conflictPath}`,
					);
				}

				expected = remoteText;
				this.persistedBaselines.set(pdfPath, remoteText);
			}
		}

		throw new Error(`Sidecar ${path} kept changing during save; local ink remains dirty`);
	}

	private async readTextOrNull(path: string): Promise<string | null> {
		if (!(await this.adapter.exists(path))) return null;
		return this.adapter.read(path);
	}

	private loadStillOwnsRevision(
		session: ReturnType<DocumentSessionManager['get']>,
		loadRevision: number,
	): boolean {
		return (
			session.state === 'loading' &&
			session.currentRevision === loadRevision &&
			!session.isDirty
		);
	}

	private queueSave(pdfPath: string, delayMs: number): void {
		this.clearTimer(pdfPath);
		if (this.shuttingDown) return;
		const id = this.timers.setTimeout(() => {
			this.saveTimers.delete(pdfPath);
			void this.save(pdfPath);
		}, delayMs);
		this.saveTimers.set(pdfPath, id);
	}

	private clearTimer(pdfPath: string): void {
		const existing = this.saveTimers.get(pdfPath);
		if (existing !== undefined) this.timers.clearTimeout(existing);
		this.saveTimers.delete(pdfPath);
	}
}
