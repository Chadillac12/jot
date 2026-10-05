import type { DataAdapter } from 'obsidian';
import { PDFDocument } from 'pdf-lib';

export class PdfTransactionWriter {
	constructor(private adapter: DataAdapter) {}

	async writeCopy(path: string, buffer: ArrayBuffer, expectedPages: number): Promise<void> {
		const tmpPath = `${path}.jot-merge-tmp`;
		await this.safeRemove(tmpPath);
		await this.adapter.writeBinary(tmpPath, buffer);
		await this.verifyPdf(tmpPath, expectedPages);
		if (await this.adapter.exists(path)) {
			throw new Error(`copy target already exists: ${path}`);
		}
		await this.adapter.rename(tmpPath, path);
		try {
			await this.verifyPdf(path, expectedPages);
		} catch (error) {
			await this.safeRemove(path);
			throw error;
		}
	}

	async replaceOriginal(path: string, buffer: ArrayBuffer, expectedPages: number): Promise<void> {
		const tmpPath = `${path}.jot-merge-tmp`;
		const backupPath = `${path}.jot-merge-backup`;
		await this.recoverStaleBackup(path, backupPath);
		await this.safeRemove(tmpPath);

		await this.adapter.writeBinary(tmpPath, buffer);
		await this.verifyPdf(tmpPath, expectedPages);

		if (!(await this.adapter.exists(path))) throw new Error(`original PDF disappeared: ${path}`);
		await this.adapter.rename(path, backupPath);
		try {
			await this.adapter.rename(tmpPath, path);
			await this.verifyPdf(path, expectedPages);
			await this.safeRemove(backupPath);
		} catch (error) {
			await this.safeRemove(path);
			if (await this.adapter.exists(backupPath)) await this.adapter.rename(backupPath, path);
			throw error;
		}
	}

	async verifyPdf(path: string, expectedPages?: number): Promise<void> {
		const bytes = await this.adapter.readBinary(path);
		const pdf = await PDFDocument.load(bytes);
		if (expectedPages !== undefined && pdf.getPageCount() !== expectedPages) {
			throw new Error(
				`PDF verification failed for ${path}: expected ${expectedPages} pages, found ${pdf.getPageCount()}`,
			);
		}
	}

	private async recoverStaleBackup(path: string, backupPath: string): Promise<void> {
		if (!(await this.adapter.exists(backupPath))) return;
		if (!(await this.adapter.exists(path))) {
			await this.adapter.rename(backupPath, path);
			await this.verifyPdf(path);
			return;
		}
		const recoveryPath = `${path}.jot-recovery-${Date.now()}.pdf`;
		await this.adapter.rename(backupPath, recoveryPath);
	}

	private async safeRemove(path: string): Promise<void> {
		if (await this.adapter.exists(path)) await this.adapter.remove(path);
	}
}
