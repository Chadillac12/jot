import type { DataAdapter } from 'obsidian';

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
