import type { DataAdapter } from 'obsidian';

let transactionCounter = 0;

export interface TransactionResult {
	backupPath: string | null;
}

export async function transactionalWriteText(
	adapter: DataAdapter,
	path: string,
	text: string,
	validate: (text: string) => void | Promise<void>,
): Promise<TransactionResult> {
	const { tempPath, backupPath } = await transactionPaths(adapter, path);
	let movedOriginal = false;
	try {
		await adapter.write(tempPath, text);
		const tempText = await adapter.read(tempPath);
		if (tempText !== text) throw new Error('Temporary write verification failed');
		await validate(tempText);

		if (await adapter.exists(path)) {
			await adapter.rename(path, backupPath);
			movedOriginal = true;
		}
		await adapter.rename(tempPath, path);

		const committed = await adapter.read(path);
		if (committed !== text) throw new Error('Committed write verification failed');
		await validate(committed);

		if (movedOriginal) {
			try {
				await adapter.remove(backupPath);
				return { backupPath: null };
			} catch {
				// The new authoritative file is verified. Keeping a stale backup is
				// safer than treating a cleanup failure as a failed commit.
				return { backupPath };
			}
		}
		return { backupPath: null };
	} catch (error) {
		await rollback(adapter, path, tempPath, backupPath, movedOriginal);
		throw error;
	}
}

export async function transactionalWriteBinary(
	adapter: DataAdapter,
	path: string,
	data: ArrayBuffer,
	validate: (data: ArrayBuffer) => void | Promise<void>,
): Promise<TransactionResult> {
	const { tempPath, backupPath } = await transactionPaths(adapter, path);
	let movedOriginal = false;
	try {
		await adapter.writeBinary(tempPath, data);
		const tempData = await adapter.readBinary(tempPath);
		await validate(tempData);

		if (await adapter.exists(path)) {
			await adapter.rename(path, backupPath);
			movedOriginal = true;
		}
		await adapter.rename(tempPath, path);

		const committed = await adapter.readBinary(path);
		await validate(committed);

		if (movedOriginal) {
			try {
				await adapter.remove(backupPath);
				return { backupPath: null };
			} catch {
				return { backupPath };
			}
		}
		return { backupPath: null };
	} catch (error) {
		await rollback(adapter, path, tempPath, backupPath, movedOriginal);
		throw error;
	}
}

async function transactionPaths(
	adapter: DataAdapter,
	path: string,
): Promise<{ tempPath: string; backupPath: string }> {
	for (let attempt = 0; attempt < 100; attempt++) {
		transactionCounter += 1;
		const suffix = `${Date.now()}-${transactionCounter}`;
		const tempPath = `${path}.jot-tmp-${suffix}`;
		const backupPath = `${path}.jot-backup-${suffix}`;
		if (!(await adapter.exists(tempPath)) && !(await adapter.exists(backupPath))) {
			return { tempPath, backupPath };
		}
	}
	throw new Error(`Unable to allocate transaction paths for ${path}`);
}

async function rollback(
	adapter: DataAdapter,
	path: string,
	tempPath: string,
	backupPath: string,
	movedOriginal: boolean,
): Promise<void> {
	try {
		if (await adapter.exists(tempPath)) await adapter.remove(tempPath);
	} catch {
		// Continue trying to restore the authoritative path.
	}

	if (!movedOriginal) return;
	try {
		if (await adapter.exists(path)) await adapter.remove(path);
		if (await adapter.exists(backupPath)) await adapter.rename(backupPath, path);
	} catch (rollbackError) {
		throw new Error(
			`Transactional write failed and rollback also failed: ${String(rollbackError)}`,
		);
	}
}
