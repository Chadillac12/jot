import type { DataAdapter } from 'obsidian';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { PdfTransactionWriter } from '../src/pdf-transaction';

interface BinaryFs {
	files: Record<string, ArrayBuffer>;
	adapter: DataAdapter;
	failNextCommitRename: () => void;
	corruptNextWrite: () => void;
}

async function pdfBytes(pages = 1): Promise<ArrayBuffer> {
	const pdf = await PDFDocument.create();
	for (let i = 0; i < pages; i++) pdf.addPage([200, 200]);
	const bytes = await pdf.save();
	const out = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(out).set(bytes);
	return out;
}

function cloneBuffer(buffer: ArrayBuffer): ArrayBuffer {
	return buffer.slice(0);
}

function makeFs(initial: Record<string, ArrayBuffer> = {}): BinaryFs {
	const files: Record<string, ArrayBuffer> = Object.fromEntries(
		Object.entries(initial).map(([path, value]) => [path, cloneBuffer(value)]),
	);
	let failCommitRename = false;
	let corruptWrite = false;
	const adapter = {
		exists: vi.fn(async (path: string) => path in files),
		readBinary: vi.fn(async (path: string) => cloneBuffer(files[path] ?? new ArrayBuffer(0))),
		writeBinary: vi.fn(async (path: string, data: ArrayBuffer) => {
			if (corruptWrite) {
				corruptWrite = false;
				files[path] = new Uint8Array([1, 2, 3, 4]).buffer;
				return;
			}
			files[path] = cloneBuffer(data);
		}),
		remove: vi.fn(async (path: string) => {
			delete files[path];
		}),
		rename: vi.fn(async (oldPath: string, newPath: string) => {
			if (failCommitRename && oldPath.endsWith('.jot-merge-tmp')) {
				failCommitRename = false;
				throw new Error('injected commit rename failure');
			}
			files[newPath] = cloneBuffer(files[oldPath] ?? new ArrayBuffer(0));
			delete files[oldPath];
		}),
	} as unknown as DataAdapter;
	return {
		files,
		adapter,
		failNextCommitRename: () => {
			failCommitRename = true;
		},
		corruptNextWrite: () => {
			corruptWrite = true;
		},
	};
}

describe('PdfTransactionWriter', () => {
	it('replaces the original only after the temporary PDF verifies', async () => {
		const original = await pdfBytes(1);
		const replacement = await pdfBytes(2);
		const fs = makeFs({ 'a.pdf': original });
		const writer = new PdfTransactionWriter(fs.adapter);

		await writer.replaceOriginal('a.pdf', replacement, 2);

		await expect(PDFDocument.load(fs.files['a.pdf']!)).resolves.toBeDefined();
		expect(fs.files['a.pdf.jot-merge-backup']).toBeUndefined();
		expect(fs.files['a.pdf.jot-merge-tmp']).toBeUndefined();
	});

	it('leaves the original untouched when temporary output is invalid', async () => {
		const original = await pdfBytes(1);
		const replacement = await pdfBytes(2);
		const fs = makeFs({ 'a.pdf': original });
		fs.corruptNextWrite();
		const writer = new PdfTransactionWriter(fs.adapter);

		await expect(writer.replaceOriginal('a.pdf', replacement, 2)).rejects.toThrow();
		expect(new Uint8Array(fs.files['a.pdf']!)).toEqual(new Uint8Array(original));
	});

	it('rolls the original back when the commit rename fails', async () => {
		const original = await pdfBytes(1);
		const replacement = await pdfBytes(2);
		const fs = makeFs({ 'a.pdf': original });
		fs.failNextCommitRename();
		const writer = new PdfTransactionWriter(fs.adapter);

		await expect(writer.replaceOriginal('a.pdf', replacement, 2)).rejects.toThrow(
			'injected commit rename failure',
		);
		expect(new Uint8Array(fs.files['a.pdf']!)).toEqual(new Uint8Array(original));
		expect(fs.files['a.pdf.jot-merge-backup']).toBeUndefined();
	});

	it('writes and verifies a copy without modifying the original', async () => {
		const original = await pdfBytes(1);
		const replacement = await pdfBytes(2);
		const fs = makeFs({ 'a.pdf': original });
		const writer = new PdfTransactionWriter(fs.adapter);

		await writer.writeCopy('a.annotated.pdf', replacement, 2);

		expect(new Uint8Array(fs.files['a.pdf']!)).toEqual(new Uint8Array(original));
		const copied = await PDFDocument.load(fs.files['a.annotated.pdf']!);
		expect(copied.getPageCount()).toBe(2);
	});
});
