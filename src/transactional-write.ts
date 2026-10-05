import type { DataAdapter, TFile, Vault } from 'obsidian';

let transactionCounter = 0;

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

export type TransactionRecoveryStatus =
	| 'none'
	| 'live'
	| 'restored-backup'
	| 'committed-temp'
	| 'rolled-back'
	| 'finalized'
	| 'unresolved';

async function transactionArtifacts(
	adapter: DataAdapter,
	path: string,
): Promise<{ backups: string[]; temps: string[] }> {
	const slash = path.lastIndexOf('/');
	const folder = slash >= 0 ? path.slice(0, slash) : '';
	const listing = await adapter.list(folder);
	const backups = listing.files
		.filter((candidate) => candidate.startsWith(`${path}.jot-backup-`))
		.sort()
		.reverse();
	const temps = listing.files
		.filter((candidate) => candidate.startsWith(`${path}.jot-tmp-`))
		.sort()
		.reverse();
	return { backups, temps };
}

async function newestValidText(
	adapter: DataAdapter,
	paths: string[],
	validate: (text: string) => boolean,
): Promise<string | null> {
	for (const candidate of paths) {
		try {
			if (validate(await adapter.read(candidate))) return candidate;
		} catch {
			// Try an older transaction artifact.
		}
	}
	return null;
}

export async function recoverInterruptedTextWrite(
	adapter: DataAdapter,
	path: string,
	validate: (text: string) => boolean,
): Promise<TransactionRecoveryStatus> {
	const { backups, temps } = await transactionArtifacts(adapter, path);
	if (backups.length === 0 && temps.length === 0) return 'none';

	const liveExists = await adapter.exists(path);
	if (liveExists) {
		try {
			if (validate(await adapter.read(path))) {
				for (const artifact of [...backups, ...temps]) await cleanup(adapter, artifact);
				return 'live';
			}
		} catch {
			// Fall through to recovery from a known-good backup.
		}
	}

	const backup = await newestValidText(adapter, backups, validate);
	if (backup) {
		if (liveExists && (await adapter.exists(path))) await adapter.remove(path);
		await adapter.rename(backup, path);
		for (const artifact of [...backups, ...temps]) {
			if (artifact !== backup) await cleanup(adapter, artifact);
		}
		return 'restored-backup';
	}

	if (!liveExists) {
		const temp = await newestValidText(adapter, temps, validate);
		if (temp) {
			await adapter.rename(temp, path);
			for (const artifact of [...backups, ...temps]) {
				if (artifact !== temp) await cleanup(adapter, artifact);
			}
			return 'committed-temp';
		}
	}
	return 'unresolved';
}

async function discardClaimArtifacts(
	adapter: DataAdapter,
	dependentPath: string,
): Promise<string[]> {
	const slash = dependentPath.lastIndexOf('/');
	const folder = slash >= 0 ? dependentPath.slice(0, slash) : '';
	const listing = await adapter.list(folder);
	return listing.files
		.filter((candidate) => candidate.startsWith(`${dependentPath}.jot-discard-`))
		.sort()
		.reverse();
}

async function newestValidBinary(
	adapter: DataAdapter,
	paths: string[],
	validate: (bytes: ArrayBuffer) => Promise<void>,
): Promise<string | null> {
	for (const candidate of paths) {
		try {
			await validate(await adapter.readBinary(candidate));
			return candidate;
		} catch {
			// Try an older transaction artifact.
		}
	}
	return null;
}

export async function recoverInterruptedVaultBinary(
	vault: Vault,
	adapter: DataAdapter,
	file: TFile,
	dependentPath: string,
	validate: (bytes: ArrayBuffer) => Promise<void>,
): Promise<TransactionRecoveryStatus> {
	const { backups, temps } = await transactionArtifacts(adapter, file.path);
	if (backups.length === 0 && temps.length === 0) return 'none';

	const backup = await newestValidBinary(adapter, backups, validate);
	if (!backup) return 'unresolved';

	let liveValid = true;
	try {
		await validate(await vault.readBinary(file));
	} catch {
		liveValid = false;
	}
	const discardClaims = await discardClaimArtifacts(adapter, dependentPath);
	if (discardClaims.length > 0) {
		const newestClaim = discardClaims[0]!;
		if (liveValid) {
			// The old sidecar was already atomically claimed, which is the durable
			// commit marker for destructive merge finalization. Keep the verified
			// merged PDF even if a newer sidecar has since synced into the live path.
			for (const artifact of [...backups, ...temps, ...discardClaims]) {
				await cleanup(adapter, artifact);
			}
			return 'finalized';
		}

		const recovery = await adapter.readBinary(backup);
		await validate(recovery);
		await vault.modifyBinary(file, recovery);
		await validate(await vault.readBinary(file));
		if (!(await adapter.exists(dependentPath)) && (await adapter.exists(newestClaim))) {
			await adapter.rename(newestClaim, dependentPath);
		}
		for (const artifact of [...backups, ...temps]) await cleanup(adapter, artifact);
		for (const claim of discardClaims) {
			if (claim !== newestClaim || (await adapter.exists(dependentPath))) {
				await cleanup(adapter, claim);
			}
		}
		return 'rolled-back';
	}

	const dependentStillExists = await adapter.exists(dependentPath);
	if (!liveValid || dependentStillExists) {
		const recovery = await adapter.readBinary(backup);
		await validate(recovery);
		await vault.modifyBinary(file, recovery);
		await validate(await vault.readBinary(file));
		for (const artifact of [...backups, ...temps]) await cleanup(adapter, artifact);
		return 'rolled-back';
	}

	for (const artifact of [...backups, ...temps]) await cleanup(adapter, artifact);
	return 'finalized';
}

export async function transactionalWriteText(
	adapter: DataAdapter,
	path: string,
	text: string,
	validate: (text: string) => boolean = (candidate) => candidate === text,
	expectedOriginal?: string | null,
): Promise<void> {
	const id = transactionId();
	const tempPath = `${path}.jot-tmp-${id}`;
	const backupPath = `${path}.jot-backup-${id}`;
	let hadOriginal = await adapter.exists(path);
	let originalMoved = false;
	let committed = false;

	try {
		await adapter.write(tempPath, text);
		const tempText = await adapter.read(tempPath);
		if (!validate(tempText)) throw new Error(`Temporary write validation failed for ${path}`);

		if (expectedOriginal !== undefined) {
			hadOriginal = await adapter.exists(path);
			const current = hadOriginal ? await adapter.read(path) : null;
			if (current !== expectedOriginal) {
				throw new Error(`Concurrent text write detected before commit for ${path}`);
			}
		}

		if (hadOriginal) {
			await adapter.rename(path, backupPath);
			originalMoved = true;
			if (expectedOriginal !== undefined && expectedOriginal !== null) {
				const claimed = await adapter.read(backupPath);
				if (claimed !== expectedOriginal) {
					throw new Error(`Concurrent text write detected while claiming ${path}`);
				}
			}
		}
		if (await adapter.exists(path)) {
			throw new Error(`Concurrent text write detected after claim for ${path}`);
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
				if (!committed && (await adapter.exists(path))) {
					// A live path appearing after the claim belongs to an external
					// writer. Never restore our older baseline over those newer bytes.
					await cleanup(adapter, backupPath);
				} else {
					if (await adapter.exists(path)) await adapter.remove(path);
					if (await adapter.exists(backupPath)) await adapter.rename(backupPath, path);
				}
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

export interface VaultBinaryFinalization {
	recoveryMarkerPath: string | null;
	rollback: () => Promise<void>;
	onCommitted: () => void;
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
	beforeFinalize?: () => Promise<VaultBinaryFinalization | void>,
): Promise<void> {
	const id = transactionId();
	const backupPath = `${file.path}.jot-backup-${id}`;
	const original = await vault.readBinary(file);
	let backupWritten = false;
	let finalization: VaultBinaryFinalization | null = null;

	try {
		await adapter.writeBinary(backupPath, original);
		backupWritten = true;
		await validate(await adapter.readBinary(backupPath));

		await vault.modifyBinary(file, bytes);
		await validate(await vault.readBinary(file));
		finalization = (await beforeFinalize?.()) ?? null;

		await cleanup(adapter, backupPath);
		const backupRemains = await adapter.exists(backupPath);
		finalization?.onCommitted();
		if (!backupRemains && finalization?.recoveryMarkerPath) {
			await cleanup(adapter, finalization.recoveryMarkerPath);
		}
	} catch (error) {
		const rollbackErrors: unknown[] = [];
		if (finalization) {
			try {
				await finalization.rollback();
			} catch (finalizationError) {
				rollbackErrors.push(finalizationError);
			}
		}
		if (backupWritten) {
			try {
				const recovery = await adapter.readBinary(backupPath);
				await validate(recovery);
				await vault.modifyBinary(file, recovery);
				await validate(await vault.readBinary(file));
			} catch (restoreError) {
				rollbackErrors.push(restoreError);
			}
		}
		if (rollbackErrors.length > 0) {
			throw new AggregateError(
				[error, ...rollbackErrors],
				`Vault binary replacement failed and rollback also failed for ${file.path}. Recovery artifacts were retained where possible.`,
			);
		}
		throw error;
	}
}

