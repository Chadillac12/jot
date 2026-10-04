/* eslint-disable @typescript-eslint/unbound-method */
import type { DataAdapter } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { transactionalWriteBinary, transactionalWriteText } from '../src/transactional-write';

function makeAdapter(initial: Record<string, string> = {}) {
	const textFiles: Record<string, string> = { ...initial };
	const binaryFiles = new Map<string, ArrayBuffer>();
	const adapter = {
		exists: vi.fn(async (path: string) => path in textFiles || binaryFiles.has(path)),
		read: vi.fn(async (path: string) => textFiles[path] ?? ''),
		write: vi.fn(async (path: string, data: string) => {
			textFiles[path] = data;
		}),
		readBinary: vi.fn(async (path: string) => binaryFiles.get(path) ?? new ArrayBuffer(0)),
		writeBinary: vi.fn(async (path: string, data: ArrayBuffer) => {
			binaryFiles.set(path, data.slice(0));
		}),
		remove: vi.fn(async (path: string) => {
			delete textFiles[path];
			binaryFiles.delete(path);
		}),
		rename: vi.fn(async (oldPath: string, newPath: string) => {
			if (oldPath in textFiles) {
				textFiles[newPath] = textFiles[oldPath]!;
				delete textFiles[oldPath];
			}
			if (binaryFiles.has(oldPath)) {
				binaryFiles.set(newPath, binaryFiles.get(oldPath)!.slice(0));
				binaryFiles.delete(oldPath);
			}
		}),
	} as unknown as DataAdapter;
	return { adapter, textFiles, binaryFiles };
}

describe('transactionalWriteText', () => {
	it('commits a verified replacement and removes temporary artifacts', async () => {
		const fs = makeAdapter({ 'a.json': 'old' });
		await transactionalWriteText(fs.adapter, 'a.json', 'new');
		expect(fs.textFiles['a.json']).toBe('new');
		expect(Object.keys(fs.textFiles).filter((path) => path.includes('jot-'))).toEqual([]);
	});

	it('restores the original if the final rename fails', async () => {
		const fs = makeAdapter({ 'a.json': 'old' });
		let renameCount = 0;
		vi.mocked(fs.adapter.rename).mockImplementation(async (oldPath: string, newPath: string) => {
			renameCount += 1;
			if (renameCount === 2) throw new Error('rename failed');
			if (oldPath in fs.textFiles) {
				fs.textFiles[newPath] = fs.textFiles[oldPath]!;
				delete fs.textFiles[oldPath];
			}
		});

		await expect(transactionalWriteText(fs.adapter, 'a.json', 'new')).rejects.toThrow(
			'rename failed',
		);
		expect(fs.textFiles['a.json']).toBe('old');
	});

	it('removes a newly committed file when final validation fails and no original existed', async () => {
		const fs = makeAdapter();
		let validations = 0;
		await expect(
			transactionalWriteText(fs.adapter, 'new.json', 'candidate', () => {
				validations += 1;
				return validations === 1;
			}),
		).rejects.toThrow('Committed write validation failed');
		expect(fs.textFiles['new.json']).toBeUndefined();
	});

	it('never replaces the original when temporary validation fails', async () => {
		const fs = makeAdapter({ 'a.json': 'old' });
		await expect(
			transactionalWriteText(fs.adapter, 'a.json', 'new', () => false),
		).rejects.toThrow('validation failed');
		expect(fs.textFiles['a.json']).toBe('old');
	});
});

describe('transactionalWriteBinary', () => {
	it('removes an invalid newly committed binary when there was no original', async () => {
		const fs = makeAdapter();
		const replacement = new Uint8Array([4, 5, 6]).buffer;
		let verificationCount = 0;

		await expect(
			transactionalWriteBinary(fs.adapter, 'new.pdf', replacement, async () => {
				verificationCount += 1;
				if (verificationCount === 2) throw new Error('committed PDF invalid');
			}),
		).rejects.toThrow('committed PDF invalid');

		expect(fs.binaryFiles.has('new.pdf')).toBe(false);
	});

	it('rolls back the original binary when dependent cleanup fails', async () => {
		const fs = makeAdapter();
		const original = new Uint8Array([1, 2, 3]).buffer;
		const replacement = new Uint8Array([4, 5, 6]).buffer;
		fs.binaryFiles.set('a.pdf', original);

		await expect(
			transactionalWriteBinary(
				fs.adapter,
				'a.pdf',
				replacement,
				async () => {},
				async () => {
					throw new Error('sidecar cleanup failed');
				},
			),
		).rejects.toThrow('sidecar cleanup failed');

		expect([...new Uint8Array(fs.binaryFiles.get('a.pdf')!)]).toEqual([1, 2, 3]);
	});

	it('rolls back the original binary when committed verification fails', async () => {
		const fs = makeAdapter();
		const original = new Uint8Array([1, 2, 3]).buffer;
		const replacement = new Uint8Array([4, 5, 6]).buffer;
		fs.binaryFiles.set('a.pdf', original);
		let verificationCount = 0;

		await expect(
			transactionalWriteBinary(fs.adapter, 'a.pdf', replacement, async () => {
				verificationCount += 1;
				if (verificationCount === 2) throw new Error('committed PDF invalid');
			}),
		).rejects.toThrow('committed PDF invalid');

		expect([...new Uint8Array(fs.binaryFiles.get('a.pdf')!)]).toEqual([1, 2, 3]);
	});
});
