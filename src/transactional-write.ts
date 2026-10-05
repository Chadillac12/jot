import type { DataAdapter, TFile, Vault } from 'obsidian';

let transactionCounter = 0;

export class TransactionConflictError extends Error {
	constructor(readonly path: string) {
		super(`Transactional write conflict for ${path}: the authoritative file changed`);
		this.name = 'TransactionConflictError';
	}
}

function transactionId(): string {
	transactionCounter += 1;
	return `${Date.now()}-${transactionCounter}`;
}

export function binaryFingerprint(bytes: ArrayBuffer): string {
	const view = new Uint8Array(bytes);
	let h1 = 0x811c9dc5;
	let h2 = 0x9e3779b9;
	for (const byte of view) {
		h1 ^= byte;
		h1 = Math.imul(h1, 0x01000193);
		h2 ^= byte + 0x9e3779b9 + (h2 << 6) + (h2 >>> 2);
		h2 = Math.imul(h2, 0x85ebca6b);
	}
	return `${view.byteLength}:${(h1 >>> 0).toString(16)}:${(h2 >>> 0).toString(16)}`;
}

function binaryEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
	if (a.byteLength !== b.byteLength) return false;
	const av = new Uint8Array(a);
	const bv = new Uint8Array(b);
	for (let i = 0; i < av.length; i++) {
		if (av[i] !== bv[i]) return false;
	}
	return true;
}

async function cleanup(adapter: DataAdapter, path: string): Promise<void> {
	try {
		if (await adapter.exists(path)) await adapter.remove(path);
	} catch {
		// Cleanup is best-effort; the authoritative/backup paths are handled
		// separately and must never be hidden by a cleanup exception.
	}
}

export type TextRecoveryResult =
	| 'none'
	| 'cleaned'
	| 'preserved'
	| 'restored-backup'
	| 'restored-temp';
export type BinaryRecoveryResult = 'none' | 'rolled-back' | 'finalized' | 'external-preserved';

async function transactionArtifacts(
	adapter: DataAdapter,
	path: string,
	kind: 'jot-backup' | 'jot-tmp',
): Promise<string[]> {
	const list = (adapter as DataAdapter & {
		list?: (path: string) => Promise<{ files: string[]; folders: string[] }>;
	}).list;
	if (typeof list !== 'function') return [];

	const slash = path.lastIndexOf('/');
	const parent = slash >= 0 ? path.slice(0, slash) : '';
	const prefix = `${path}.${kind}-`;
	const listing = await list.call(adapter, parent);
	return listing.files
		.map((candidate) => {
			if (candidate.startsWith(prefix)) return candidate;
			if (!candidate.includes('/')) {
				const normalized = parent ? `${parent}/${candidate}` : candidate;
				return normalized.startsWith(prefix) ? normalized : '';
			}
			return '';
		})
		.filter((candidate): candidate is string => candidate.length > 0)
		.sort((a, b) => compareTransactionArtifacts(path, kind, b, a));
}

function compareTransactionArtifacts(
	path: string,
	kind: 'jot-backup' | 'jot-tmp',
	a: string,
	b: string,
): number {
	const prefix = `${path}.${kind}-`;
	const parse = (candidate: string): [number, number] => {
		const [timestamp = '0', counter = '0'] = candidate.slice(prefix.length).split('-');
		return [Number(timestamp) || 0, Number(counter) || 0];
	};
	const [aTimestamp, aCounter] = parse(a);
	const [bTimestamp, bCounter] = parse(b);
	return aTimestamp - bTimestamp || aCounter - bCounter;
}

async function preserveTextArtifact(
	adapter: DataAdapter,
	path: string,
	artifact: string,
	kind: 'jot-backup' | 'jot-tmp',
): Promise<void> {
	const prefix = `${path}.${kind}-`;
	const id = artifact.slice(prefix.length);
	let recoveryPath = `${path}.recovery-${kind}-${id}.json`;
	if (await adapter.exists(recoveryPath)) {
		const existing = await adapter.read(recoveryPath);
		const candidate = await adapter.read(artifact);
		if (existing === candidate) {
			await cleanup(adapter, artifact);
			return;
		}
		recoveryPath = `${path}.recovery-${kind}-${id}-${Date.now()}.json`;
	}
	await adapter.rename(artifact, recoveryPath);
}

export async function recoverInterruptedTextWrite(
	adapter: DataAdapter,
	path: string,
	validate: (text: string) => boolean,
): Promise<TextRecoveryResult> {
	const backups = await transactionArtifacts(adapter, path, 'jot-backup');
	const temps = await transactionArtifacts(adapter, path, 'jot-tmp');
	if (backups.length === 0 && temps.length === 0) return 'none';

	if (await adapter.exists(path)) {
		const current = await adapter.read(path);
		if (!validate(current)) return 'none';
		let preserved = false;
		for (const [kind, artifacts] of [
			['jot-backup', backups],
			['jot-tmp', temps],
		] as const) {
			for (const artifact of artifacts) {
				try {
					const candidate = await adapter.read(artifact);
					if (candidate === current) {
						await cleanup(adapter, artifact);
					} else {
						await preserveTextArtifact(adapter, path, artifact, kind);
						preserved = true;
					}
				} catch {
					// If an artifact cannot be inspected, leave it untouched rather
					// than risk deleting the only surviving copy of interrupted data.
					preserved = true;
				}
			}
		}
		return preserved ? 'preserved' : 'cleaned';
	}

	for (const [kind, candidates] of [
		['restored-backup', backups],
		['restored-temp', temps],
	] as const) {
		for (const candidate of candidates) {
			try {
				const text = await adapter.read(candidate);
				if (!validate(text)) continue;
				if (await adapter.exists(path)) return 'none';
				await adapter.rename(candidate, path);
				for (const artifact of [...backups, ...temps]) {
					if (artifact !== candidate) await cleanup(adapter, artifact);
				}
				return kind;
			} catch {
				// Try the next validated recovery candidate.
			}
		}
	}

	return 'none';
}

export async function recoverInterruptedVaultBinary(
	vault: Vault,
	adapter: DataAdapter,
	file: TFile,
	validate: (bytes: ArrayBuffer) => Promise<void>,
	dependentPath: string,
): Promise<BinaryRecoveryResult> {
	const backups = await transactionArtifacts(adapter, file.path, 'jot-backup');
	if (backups.length === 0) return 'none';

	const backupPath = backups[0]!;
	const id = backupPath.slice(`${file.path}.jot-backup-`.length);
	const markerPath = `${file.path}.jot-txn-${id}`;
	const backup = await adapter.readBinary(backupPath);
	await validate(backup);
	const current = await vault.readBinary(file);
	await validate(current);

	// If the tracked file already equals the recovery backup, the overwrite
	// either never reached the live PDF or was already rolled back.
	if (binaryEqual(current, backup)) {
		for (const artifact of backups) await cleanup(adapter, artifact);
		await cleanup(adapter, markerPath);
		return 'rolled-back';
	}

	let replacementFingerprint: string | null = null;
	if (await adapter.exists(markerPath)) {
		try {
			const marker = JSON.parse(await adapter.read(markerPath)) as {
				version?: unknown;
				replacementFingerprint?: unknown;
			};
			if (marker.version === 1 && typeof marker.replacementFingerprint === 'string') {
				replacementFingerprint = marker.replacementFingerprint;
			}
		} catch {
			// An unreadable marker cannot prove ownership of the current PDF.
		}
	}

	// Never overwrite an unknown current PDF during crash recovery. This covers
	// legacy pre-marker transactions and a synced PDF that replaced our merged
	// bytes while Jot was stopped.
	if (
		replacementFingerprint === null ||
		binaryFingerprint(current) !== replacementFingerprint
	) {
		for (const artifact of backups) {
			const artifactId = artifact.slice(`${file.path}.jot-backup-`.length);
			const recoveryPath = `${file.path}.recovery-${artifactId}.pdf`;
			if (await adapter.exists(artifact)) {
				if (await adapter.exists(recoveryPath)) {
					await cleanup(adapter, artifact);
				} else {
					await adapter.rename(artifact, recoveryPath);
				}
			}
			await cleanup(adapter, `${file.path}.jot-txn-${artifactId}`);
		}
		return 'external-preserved';
	}

	const dependentBackups = await transactionArtifacts(adapter, dependentPath, 'jot-backup');
	if ((await adapter.exists(dependentPath)) || dependentBackups.length > 0) {
		await vault.modifyBinary(file, backup);
		const restored = await vault.readBinary(file);
		if (!binaryEqual(restored, backup)) {
			throw new Error(`Recovered PDF verification failed for ${file.path}`);
		}
		await validate(restored);
		for (const artifact of backups) await cleanup(adapter, artifact);
		await cleanup(adapter, markerPath);
		return 'rolled-back';
	}

	// Sidecar cleanup reached its commit point, and the current PDF is exactly
	// the replacement recorded by this transaction.
	for (const artifact of backups) await cleanup(adapter, artifact);
	await cleanup(adapter, markerPath);
	return 'finalized';
}

export async function transactionalWriteText(
	adapter: DataAdapter,
	path: string,
	text: string,
	validate: (text: string) => boolean = (candidate) => candidate === text,
	expectedCurrent?: string | null,
): Promise<void> {
	const id = transactionId();
	const tempPath = `${path}.jot-tmp-${id}`;
	const backupPath = `${path}.jot-backup-${id}`;
	const hadOriginal = await adapter.exists(path);
	let originalMoved = false;
	let committed = false;

	try {
		await adapter.write(tempPath, text);
		const tempText = await adapter.read(tempPath);
		if (!validate(tempText)) throw new Error(`Temporary write validation failed for ${path}`);

		if (
			expectedCurrent !== undefined &&
			hadOriginal !== (expectedCurrent !== null)
		) {
			throw new TransactionConflictError(path);
		}

		if (hadOriginal) {
			await adapter.rename(path, backupPath);
			originalMoved = true;
			if (expectedCurrent !== undefined) {
				const movedOriginal = await adapter.read(backupPath);
				if (movedOriginal !== expectedCurrent) {
					throw new TransactionConflictError(path);
				}
			}
		} else if (expectedCurrent === null && (await adapter.exists(path))) {
			// The path appeared after the initial exists() check. Do not blindly
			// rename over a newly arrived synced file.
			throw new TransactionConflictError(path);
		}
		await adapter.rename(tempPath, path);
		committed = true;

		const committedText = await adapter.read(path);
		if (!validate(committedText)) throw new Error(`Committed write validation failed for ${path}`);

		if (originalMoved) await cleanup(adapter, backupPath);
	} catch (error) {
		await cleanup(adapter, tempPath);
		try {
			if (committed && !originalMoved && (await adapter.exists(path))) {
				const current = await adapter.read(path);
				if (current === text) await adapter.remove(path);
			}
			if (originalMoved && (await adapter.exists(backupPath))) {
				if (!(await adapter.exists(path))) {
					await adapter.rename(backupPath, path);
				} else {
					const current = await adapter.read(path);
					if (current === text) {
						await adapter.remove(path);
						await adapter.rename(backupPath, path);
					} else {
						const conflictPath = `${path}.conflict-${id}.json`;
						await adapter.rename(backupPath, conflictPath);
					}
				}
			}
		} catch (restoreError) {
			throw new AggregateError(
				[error, restoreError],
				`Write failed and rollback also failed for ${path}`,
			);
		}
		throw error;
	}
}

/**
 * Remove a text file only if the exact file moved out of the authoritative
 * path still matches the caller's verified baseline. Renaming first closes the
 * read-then-remove race: a synced replacement that appears afterward remains
 * at the canonical path and is never deleted.
 */
export async function transactionalRemoveTextExpected(
	adapter: DataAdapter,
	path: string,
	expectedCurrent: string | null,
): Promise<void> {
	if (expectedCurrent === null) {
		if (await adapter.exists(path)) throw new TransactionConflictError(path);
		return;
	}

	const id = transactionId();
	const backupPath = `${path}.jot-backup-${id}`;
	const conflictPath = `${path}.conflict-${id}.json`;
	let moved = false;

	try {
		if (!(await adapter.exists(path))) throw new TransactionConflictError(path);
		await adapter.rename(path, backupPath);
		moved = true;

		const movedText = await adapter.read(backupPath);
		if (movedText !== expectedCurrent) throw new TransactionConflictError(path);

		// The exact baseline is now quarantined. If a synced replacement arrived
		// after the rename, it lives at path and is left untouched.
		await adapter.remove(backupPath);
		moved = false;
	} catch (error) {
		if (moved) {
			try {
				if (!(await adapter.exists(path))) {
					await adapter.rename(backupPath, path);
				} else if (await adapter.exists(backupPath)) {
					// A newer canonical file appeared while the old one was
					// quarantined. Preserve both instead of overwriting either.
					await adapter.rename(backupPath, conflictPath);
				}
				moved = false;
			} catch (restoreError) {
				throw new AggregateError(
					[error, restoreError],
					`Delete conflict for ${path} could not be safely rolled back. Quarantined data may remain at ${backupPath}`,
				);
			}
		}
		throw error;
	}
}

export async function transactionalWriteBinary(
	adapter: DataAdapter,
	path: string,
	bytes: ArrayBuffer,
	validate: (bytes: ArrayBuffer) => Promise<void>,
	beforeFinalize?: () => Promise<void>,
	expectedCurrent?: ArrayBuffer | null,
): Promise<void> {
	const id = transactionId();
	const tempPath = `${path}.jot-tmp-${id}`;
	const backupPath = `${path}.jot-backup-${id}`;
	const recoveryPath = `${path}.recovery-${id}`;
	const hadOriginal = await adapter.exists(path);
	let originalMoved = false;
	let committed = false;

	try {
		await adapter.writeBinary(tempPath, bytes);
		const tempBytes = await adapter.readBinary(tempPath);
		if (!binaryEqual(tempBytes, bytes)) {
			throw new Error(`Temporary binary write verification failed for ${path}`);
		}
		await validate(tempBytes);

		if (
			expectedCurrent !== undefined &&
			hadOriginal !== (expectedCurrent !== null)
		) {
			throw new TransactionConflictError(path);
		}

		if (hadOriginal) {
			await adapter.rename(path, backupPath);
			originalMoved = true;
			if (expectedCurrent instanceof ArrayBuffer) {
				const movedOriginal = await adapter.readBinary(backupPath);
				if (!binaryEqual(movedOriginal, expectedCurrent)) {
					throw new TransactionConflictError(path);
				}
			}
		} else if (expectedCurrent === null && (await adapter.exists(path))) {
			throw new TransactionConflictError(path);
		}

		await adapter.rename(tempPath, path);
		committed = true;
		const committedBytes = await adapter.readBinary(path);
		if (!binaryEqual(committedBytes, bytes)) {
			throw new TransactionConflictError(path);
		}
		await validate(committedBytes);
		await beforeFinalize?.();

		if (originalMoved) await cleanup(adapter, backupPath);
	} catch (error) {
		await cleanup(adapter, tempPath);
		try {
			if (committed && !originalMoved && (await adapter.exists(path))) {
				const current = await adapter.readBinary(path);
				if (binaryEqual(current, bytes)) await adapter.remove(path);
			}
			if (originalMoved && (await adapter.exists(backupPath))) {
				if (!(await adapter.exists(path))) {
					await adapter.rename(backupPath, path);
				} else {
					const current = await adapter.readBinary(path);
					if (binaryEqual(current, bytes)) {
						await adapter.remove(path);
						await adapter.rename(backupPath, path);
					} else if (await adapter.exists(recoveryPath)) {
						await cleanup(adapter, backupPath);
					} else {
						await adapter.rename(backupPath, recoveryPath);
					}
				}
			}
		} catch (restoreError) {
			throw new AggregateError(
				[error, restoreError],
				`Binary write failed and rollback also failed for ${path}`,
			);
		}
		throw error;
	}
}

/**
 * Transactionally replace a vault-tracked binary without renaming the live
 * TFile out from under Obsidian. A verified durable backup is created first.
 * If replacement validation or dependent cleanup fails, the original bytes
 * are restored through Vault.modifyBinary before the error is rethrown.
 */
export async function transactionalModifyVaultBinary(
	vault: Vault,
	adapter: DataAdapter,
	file: TFile,
	bytes: ArrayBuffer,
	validate: (bytes: ArrayBuffer) => Promise<void>,
	beforeFinalize?: () => Promise<void>,
	expectedCurrent?: ArrayBuffer,
): Promise<void> {
	const id = transactionId();
	const backupPath = `${file.path}.jot-backup-${id}`;
	const markerPath = `${file.path}.jot-txn-${id}`;
	const original = await vault.readBinary(file);
	if (expectedCurrent && !binaryEqual(original, expectedCurrent)) {
		throw new TransactionConflictError(file.path);
	}
	let backupWritten = false;
	let markerWritten = false;

	try {
		await adapter.writeBinary(backupPath, original);
		backupWritten = true;
		await validate(await adapter.readBinary(backupPath));

		const markerText = JSON.stringify({
			version: 1,
			replacementFingerprint: binaryFingerprint(bytes),
		});
		await adapter.write(markerPath, markerText);
		if ((await adapter.read(markerPath)) !== markerText) {
			throw new Error(`PDF transaction marker verification failed for ${file.path}`);
		}
		markerWritten = true;

		const preCommit = await vault.readBinary(file);
		if (!binaryEqual(preCommit, original)) {
			throw new TransactionConflictError(file.path);
		}

		await vault.modifyBinary(file, bytes);
		const committed = await vault.readBinary(file);
		if (!binaryEqual(committed, bytes)) {
			throw new TransactionConflictError(file.path);
		}
		await validate(committed);

		const beforeCleanup = await vault.readBinary(file);
		if (!binaryEqual(beforeCleanup, bytes)) {
			throw new TransactionConflictError(file.path);
		}
		await beforeFinalize?.();

		await cleanup(adapter, backupPath);
		await cleanup(adapter, markerPath);
	} catch (error) {
		if (backupWritten) {
			try {
				const current = await vault.readBinary(file);
				if (binaryEqual(current, bytes)) {
					const recovery = await adapter.readBinary(backupPath);
					await validate(recovery);
					await vault.modifyBinary(file, recovery);
					const restored = await vault.readBinary(file);
					if (!binaryEqual(restored, recovery)) {
						throw new Error(`PDF rollback verification failed for ${file.path}`);
					}
					await validate(restored);
				} else if (!binaryEqual(current, original)) {
					// The current PDF is neither the pre-merge original nor the
					// replacement Jot wrote. Preserve that external PDF and move
					// our original backup out of automatic-recovery namespace.
					const recoveryPath = `${file.path}.recovery-${id}.pdf`;
					if (await adapter.exists(backupPath)) {
						if (await adapter.exists(recoveryPath)) {
							await cleanup(adapter, backupPath);
						} else {
							await adapter.rename(backupPath, recoveryPath);
						}
					}
					await cleanup(adapter, markerPath);
					throw new AggregateError(
						[error, new TransactionConflictError(file.path)],
						`PDF changed externally during merge; external PDF was preserved and the pre-merge backup was saved at ${recoveryPath}`,
					);
				}
			} catch (restoreError) {
				if (restoreError instanceof AggregateError) throw restoreError;
				throw new AggregateError(
					[error, restoreError],
					`Vault binary replacement failed and rollback also failed for ${file.path}. Recovery backup remains at ${backupPath}`,
				);
			}
		} else if (markerWritten) {
			await cleanup(adapter, markerPath);
		}
		throw error;
	}
}

