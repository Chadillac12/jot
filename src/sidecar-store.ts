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
	recoverInterruptedTextWrite,
	transactionalWriteText,
	type VaultBinaryFinalization,
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
	// Last disk bytes that this session actually observed or successfully wrote.
	// undefined means no baseline; null means the sidecar was verified absent.
	private persistedSidecars = new Map<string, string | null>();
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
		const loadToken = session.beginLoad();
		if (!loadToken) return 'dirty';

		const path = jotPathFor(pdfPath);
		try {
			await recoverInterruptedTextWrite(
				this.adapter,
				path,
				(candidate) => parseJotText(candidate) !== null,
			);
			if (!(await this.adapter.exists(path))) {
				if (!session.completeLoad(loadToken)) return 'dirty';
				this.protectedOriginals.delete(pdfPath);
				this.persistedSidecars.set(pdfPath, null);
				this.strokes.clearFor(pdfPath);
				return 'missing';
			}

			const text = await this.adapter.read(path);
			const parsed = parseJotText(text);
			if (!parsed) {
				this.protectedOriginals.set(pdfPath, text);
				this.persistedSidecars.set(pdfPath, text);
				const error = new Error(`${path} is invalid`);
				session.failLoad(loadToken, error);
				console.warn(`${PLUGIN_LOG} ${error.message}; keeping current annotations in memory`);
				return 'protected';
			}
			if (!isSupportedVersion(parsed.version)) {
				this.protectedOriginals.set(pdfPath, text);
				this.persistedSidecars.set(pdfPath, text);
				const error = new Error(`${path} has unknown version ${parsed.version}`);
				session.failLoad(loadToken, error);
				console.warn(`${PLUGIN_LOG} ${error.message}; keeping current annotations in memory`);
				return 'protected';
			}

			if (!session.completeLoad(loadToken)) return 'dirty';
			this.protectedOriginals.delete(pdfPath);
			this.persistedSidecars.set(pdfPath, text);
			this.strokes.clearFor(pdfPath);
			this.strokes.populateFromPayload(pdfPath, parsed.pages);
			return 'loaded';
		} catch (error) {
			session.failLoad(loadToken, error);
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
			const currentDiskText = await this.readSidecarText(path);
			const baseline = this.persistedSidecars.get(pdfPath);
			if (baseline === undefined) {
				// A save without a prior load must never silently replace an existing sidecar.
				if (currentDiskText !== null && currentDiskText !== text) {
					await this.preserveDiskConflict(path, currentDiskText);
				}
				this.persistedSidecars.set(pdfPath, currentDiskText);
			} else if (currentDiskText !== baseline && currentDiskText !== text) {
				// Catch sync writes that land inside the modify-event/save race window.
				if (currentDiskText !== null) {
					await this.preserveDiskConflict(path, currentDiskText);
				}
				session.markConflict(
					new Error('Sidecar changed externally since the last verified baseline'),
				);
				this.persistedSidecars.set(pdfPath, currentDiskText);
				session.resolveConflictKeepLocal();
			}

			const protectedText = this.protectedOriginals.get(pdfPath);
			if (protectedText !== undefined) {
				const recoveryPath = `${path}.recovery-${Date.now()}.json`;
				await transactionalWriteText(this.adapter, recoveryPath, protectedText);
			}

			const expectedDiskText = this.persistedSidecars.get(pdfPath);
			if (expectedDiskText === undefined) {
				throw new Error('Sidecar save has no verified persistence baseline');
			}
			await transactionalWriteText(
				this.adapter,
				path,
				text,
				(candidate) => {
					const parsed = parseJotText(candidate);
					return parsed !== null && isSupportedVersion(parsed.version);
				},
				expectedDiskText,
			);
			this.protectedOriginals.delete(pdfPath);
			this.persistedSidecars.set(pdfPath, text);
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

	hasPendingSave(pdfPath: string): boolean {
		return this.sessions.get(pdfPath).isDirty || this.saveTimers.has(pdfPath);
	}

	beginShutdown(): void {
		this.shuttingDown = true;
		for (const path of [...this.saveTimers.keys()]) this.clearTimer(path);
	}

	async preserveExternalConflictAndFlushLocal(pdfPath: string): Promise<string | null> {
		const session = this.sessions.get(pdfPath);
		if (!session.isDirty) return null;

		const sidecarPath = jotPathFor(pdfPath);
		try {
			if (!(await this.adapter.exists(sidecarPath))) return null;
			const remoteText = await this.adapter.read(sidecarPath);
			const conflictPath = await this.preserveDiskConflict(sidecarPath, remoteText);
			this.persistedSidecars.set(pdfPath, remoteText);
			session.markConflict();
			session.resolveConflictKeepLocal();
			await this.flush(pdfPath);
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
		const persistedText = this.persistedSidecars.get(oldPdfPath);
		this.persistedSidecars.delete(oldPdfPath);
		if (persistedText !== undefined) this.persistedSidecars.set(newPdfPath, persistedText);
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
				if (await this.adapter.exists(newSidecar)) {
					const destinationText = await this.adapter.read(newSidecar);
					const conflictPath = `${newSidecar}.conflict-${Date.now()}.json`;
					await transactionalWriteText(this.adapter, conflictPath, destinationText);
				}
				await transactionalWriteText(this.adapter, newSidecar, sourceText);
				await this.adapter.remove(oldSidecar);
				this.persistedSidecars.set(newPdfPath, sourceText);
			} else {
				this.persistedSidecars.set(newPdfPath, null);
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

	getPersistedBaseline(pdfPath: string): string | null | undefined {
		return this.persistedSidecars.get(pdfPath);
	}

	async claimDiscard(
		pdfPath: string,
		expectedText: string | null,
	): Promise<VaultBinaryFinalization> {
		if (!(await this.flush(pdfPath))) {
			throw new Error(`Cannot discard ${pdfPath} annotations because dirty data failed to save`);
		}
		const path = jotPathFor(pdfPath);
		const exists = await this.adapter.exists(path);
		if ((expectedText === null && exists) || (expectedText !== null && !exists)) {
			throw new Error(
				`Cannot discard ${pdfPath} annotations because the sidecar changed during the protected operation`,
			);
		}

		let claimedPath: string | null = null;
		if (expectedText !== null) {
			claimedPath = `${path}.jot-discard-${Date.now()}-${this.sessions.get(pdfPath).currentRevision}`;
			await this.adapter.rename(path, claimedPath);
			const claimedText = await this.adapter.read(claimedPath);
			if (claimedText !== expectedText) {
				if (!(await this.adapter.exists(path))) {
					await this.adapter.rename(claimedPath, path);
				}
				throw new Error(
					`Cannot discard ${pdfPath} annotations because the claimed sidecar did not match the protected baseline`,
				);
			}
		}

		const rollback = async (): Promise<void> => {
			if (!claimedPath || !(await this.adapter.exists(claimedPath))) return;
			if (!(await this.adapter.exists(path))) {
				await this.adapter.rename(claimedPath, path);
				return;
			}
			const conflictPath = `${path}.conflict-${Date.now()}.json`;
			await this.adapter.rename(claimedPath, conflictPath);
		};
		const onCommitted = (): void => {
			this.protectedOriginals.delete(pdfPath);
			this.persistedSidecars.delete(pdfPath);
			this.ownedPdfPaths.delete(pdfPath);
			this.sessions.remove(pdfPath);
		};
		return { recoveryMarkerPath: claimedPath, rollback, onCommitted };
	}

	async discard(pdfPath: string, expectedText?: string | null): Promise<void> {
		if (expectedText !== undefined) {
			const claim = await this.claimDiscard(pdfPath, expectedText);
			claim.onCommitted();
			if (claim.recoveryMarkerPath && (await this.adapter.exists(claim.recoveryMarkerPath))) {
				await this.adapter.remove(claim.recoveryMarkerPath);
			}
			return;
		}
		if (!(await this.flush(pdfPath))) {
			throw new Error(`Cannot discard ${pdfPath} annotations because dirty data failed to save`);
		}
		const path = jotPathFor(pdfPath);
		if (await this.adapter.exists(path)) await this.adapter.remove(path);
		this.protectedOriginals.delete(pdfPath);
		this.persistedSidecars.delete(pdfPath);
		this.ownedPdfPaths.delete(pdfPath);
		this.sessions.remove(pdfPath);
	}

	private async readSidecarText(path: string): Promise<string | null> {
		return (await this.adapter.exists(path)) ? this.adapter.read(path) : null;
	}

	private async preserveDiskConflict(path: string, text: string): Promise<string> {
		const conflictPath = `${path}.conflict-${Date.now()}.json`;
		await transactionalWriteText(this.adapter, conflictPath, text);
		console.warn(`${PLUGIN_LOG} preserved competing sidecar at ${conflictPath}`);
		return conflictPath;
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
