import type { DataAdapter } from 'obsidian';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => ({
	Notice: class {},
	Modal: class {
		contentEl = document.createElement('div');
		constructor(_app?: unknown) {}
		open(): void {}
		close(): void {}
	},
}));
import { DocumentSessionManager } from '../src/document-session';
import { JOT_FORMAT_VERSION } from '../src/jot-file';
import { PdfMergeExecutor } from '../src/pdf-merge-executor';
import { SidecarStore } from '../src/sidecar-store';

interface MergeFs {
	text: Record<string, string>;
	binary: Record<string, ArrayBuffer>;
	adapter: DataAdapter;
	failPdfCommit: () => void;
}

async function makePdf(): Promise<ArrayBuffer> {
	const pdf = await PDFDocument.create();
	pdf.addPage([612, 792]);
	const bytes = await pdf.save();
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
}

function sidecarText(): string {
	return JSON.stringify({
		version: JOT_FORMAT_VERSION,
		pages: {
			'1': [
				{
					points: [{ x: 0.5, y: 0.5, pressure: 0.7 }],
					color: '#123456',
					width: 0.0025,
					tool: 'pen',
					render: { version: 2, smoothing: 0.5, pressureSensitivity: 0.5 },
				},
			],
		},
	});
}

function makeFs(): MergeFs {
	const text: Record<string, string> = {};
	const binary: Record<string, ArrayBuffer> = {};
	let failCommit = false;
	const adapter = {
		exists: vi.fn(async (path: string) => path in text || path in binary),
		read: vi.fn(async (path: string) => {
			const value = text[path];
			if (value === undefined) throw new Error(`missing text ${path}`);
			return value;
		}),
		write: vi.fn(async (path: string, value: string) => {
			text[path] = value;
		}),
		readBinary: vi.fn(async (path: string) => {
			const value = binary[path];
			if (!value) throw new Error(`missing binary ${path}`);
			return value.slice(0);
		}),
		writeBinary: vi.fn(async (path: string, value: ArrayBuffer) => {
			binary[path] = value.slice(0);
		}),
		rename: vi.fn(async (oldPath: string, newPath: string) => {
			if (
				failCommit &&
				oldPath.includes('.jot-tmp-') &&
				newPath === 'notes.pdf'
			) {
				failCommit = false;
				throw new Error('injected PDF commit failure');
			}
			if (oldPath in text) {
				text[newPath] = text[oldPath]!;
				delete text[oldPath];
				return;
			}
			if (oldPath in binary) {
				binary[newPath] = binary[oldPath]!;
				delete binary[oldPath];
				return;
			}
			throw new Error(`missing ${oldPath}`);
		}),
		remove: vi.fn(async (path: string) => {
			delete text[path];
			delete binary[path];
		}),
	} as unknown as DataAdapter;

	return {
		text,
		binary,
		adapter,
		failPdfCommit: () => {
			failCommit = true;
		},
	};
}

async function harness() {
	const fs = makeFs();
	fs.binary['notes.pdf'] = await makePdf();
	fs.text['notes.pdf.jot.json'] = sidecarText();
	const sessions = new DocumentSessionManager();
	const sidecar = new SidecarStore(fs.adapter, sessions);
	expect(await sidecar.load('notes.pdf')).toBe('loaded');
	const redraw = vi.fn();
	const merge = new PdfMergeExecutor(
		fs.adapter,
		sessions.strokes,
		sidecar,
		sessions.history,
		redraw,
	);
	return { fs, sessions, sidecar, merge, redraw };
}

describe('MergeService transactional overwrite', () => {
	it('rolls the original PDF back and preserves annotations if commit fails', async () => {
		const { fs, sessions, merge, redraw } = await harness();
		const original = fs.binary['notes.pdf']!.slice(0);
		fs.failPdfCommit();

		await expect(
			merge.execute('notes.pdf', 'overwrite', 'unused.pdf'),
		).rejects.toThrow('injected PDF commit failure');

		const restored = fs.binary['notes.pdf'];
		expect(restored).toBeDefined();
		await expect(PDFDocument.load(restored!)).resolves.toBeDefined();
		expect([...new Uint8Array(restored!)]).toEqual([...new Uint8Array(original)]);
		expect(fs.text['notes.pdf.jot.json']).toBeDefined();
		expect(sessions.strokes.forPage('notes.pdf', 1)).toHaveLength(1);
		expect(redraw).not.toHaveBeenCalled();
	});

	it('clears sidecar and in-memory ink only after a verified overwrite succeeds', async () => {
		const { fs, sessions, merge, redraw } = await harness();

		const { outPath } = await merge.execute('notes.pdf', 'overwrite', 'unused.pdf');

		expect(outPath).toBe('notes.pdf');
		const committed = fs.binary['notes.pdf'];
		expect(committed).toBeDefined();
		const loaded = await PDFDocument.load(committed!);
		expect(loaded.getPageCount()).toBe(1);
		expect(fs.text['notes.pdf.jot.json']).toBeUndefined();
		expect(sessions.strokes.forPage('notes.pdf', 1)).toHaveLength(0);
		expect(redraw).toHaveBeenCalledTimes(1);
	});

	it('keeps the sidecar and memory if annotation cleanup fails after PDF commit', async () => {
		const { fs, sessions, merge } = await harness();
		const originalRemove = fs.adapter.remove.bind(fs.adapter);
		vi.mocked(fs.adapter.remove).mockImplementation(async (path: string) => {
			if (path === 'notes.pdf.jot.json') throw new Error('injected sidecar delete failure');
			await originalRemove(path);
		});

		await expect(
			merge.execute('notes.pdf', 'overwrite', 'unused.pdf'),
		).rejects.toThrow('injected sidecar delete failure');

		expect(fs.text['notes.pdf.jot.json']).toBeDefined();
		expect(sessions.strokes.forPage('notes.pdf', 1)).toHaveLength(1);
		await expect(PDFDocument.load(fs.binary['notes.pdf']!)).resolves.toBeDefined();
	});
});
