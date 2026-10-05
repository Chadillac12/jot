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

async function cleanup(adapter: DataAdapter, path: string): Promise<void> {
	try {
		if (await adapter.exists(path)) await adapter.remove(path);
	} catch {
		// Cleanup is best-effort; the authoritative/backup paths are handled
		// separately and must never be hidden by a cleanup exception.
	}
}

export type TextRecoveryResult = 'none' | 'cleaned' | 'restored-backup' | 'restored-temp';
export type BinaryRecoveryResult = 'none' | 'rolled-back' | 'finalized';

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
		.sort()
		.reverse();
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
		for (const artifact of [...backups, ...temps]) await cleanup(adapter, artifact);
		return 'cleaned';
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
	const dependentBackups = await transactionArtifacts(adapter, dependentPath, 'jot-backup');
	if ((await adapter.exists(dependentPath)) || dependentBackups.length > 0) {
		const recovery = await adapter.readBinary(backupPath);
		await validate(recovery);
		await vault.modifyBinary(file, recovery);
		await validate(await vault.readBinary(file));
		for (const artifact of backups) await cleanup(adapter, artifact);
		return 'rolled-back';
	}

	// The dependent cleanup already completed, so the overwrite transaction
	// reached its logical commit point. Keep the current verified PDF and only
	// remove the orphan recovery backup.
	await validate(await vault.readBinary(file));
	for (const artifact of backups) await cleanup(adapter, artifact);
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
		if (committed && !originalMoved) await cleanup(adapter, path);
		if (originalMoved) {
			try {
				if (await adapter.exists(path)) await adapter.remove(path);
				if (await adapter.exists(backupPath)) await adapter.rename(backupPath, path);
			} catch (restoreError) {
				throw new AggregateError(
					[error, restoreError],
					`Write failed and rollback also failed for ${path}`,
				);
			}
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
): Promise<void> {
	const id = transactionId();
	const tempPath = `${path}.jot-tmp-${id}`;
	const backupPath = `${path}.jot-backup-${id}`;
	const hadOriginal = await adapter.exists(path);
	let originalMoved = false;
	let committed = false;

	try {
		await adapter.writeBinary(tempPath, bytes);
		await validate(await adapter.readBinary(tempPath));

		if (hadOriginal) {
			await adapter.rename(path, backupPath);
			originalMoved = true;
		}
		await adapter.rename(tempPath, path);
		committed = true;
		await validate(await adapter.readBinary(path));
		await beforeFinalize?.();

		if (originalMoved) await cleanup(adapter, backupPath);
	} catch (error) {
		await cleanup(adapter, tempPath);
		if (committed && !originalMoved) await cleanup(adapter, path);
		if (originalMoved) {
			try {
				if (await adapter.exists(path)) await adapter.remove(path);
				if (await adapter.exists(backupPath)) await adapter.rename(backupPath, path);
			} catch (restoreError) {
				throw new AggregateError(
					[error, restoreError],
					`Binary write failed and rollback also failed for ${path}`,
				);
			}
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
): Promise<void> {
	const id = transactionId();
	const backupPath = `${file.path}.jot-backup-${id}`;
	const original = await vault.readBinary(file);
	let backupWritten = false;

	try {
		await adapter.writeBinary(backupPath, original);
		backupWritten = true;
		await validate(await adapter.readBinary(backupPath));

		await vault.modifyBinary(file, bytes);
		await validate(await vault.readBinary(file));
		await beforeFinalize?.();

		await cleanup(adapter, backupPath);
	} catch (error) {
		if (backupWritten) {
			try {
				const recovery = await adapter.readBinary(backupPath);
				await validate(recovery);
				await vault.modifyBinary(file, recovery);
				await validate(await vault.readBinary(file));
			} catch (restoreError) {
				throw new AggregateError(
					[error, restoreError],
					`Vault binary replacement failed and rollback also failed for ${file.path}. Recovery backup remains at ${backupPath}`,
				);
			}
		}
		throw error;
	}
}

