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

export async function transactionalWriteText(
	adapter: DataAdapter,
	path: string,
	text: string,
	validate: (text: string) => boolean = (candidate) => candidate === text,
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

		if (hadOriginal) {
			await adapter.rename(path, backupPath);
			originalMoved = true;
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

