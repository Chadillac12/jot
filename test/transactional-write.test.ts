/* eslint-disable @typescript-eslint/unbound-method, obsidianmd/no-tfile-tfolder-cast */
import type { DataAdapter, TFile, Vault } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import {
	recoverInterruptedTextWrite,
	recoverInterruptedVaultBinary,
	transactionalModifyVaultBinary,
	transactionalWriteBinary,
	transactionalWriteText,
} from '../src/transactional-write';

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
		list: vi.fn(async () => ({
			files: [...Object.keys(textFiles), ...binaryFiles.keys()],
			folders: [],
		})),
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

	it('preserves an external write that appears after the transaction claims the baseline', async () => {
		const fs = makeAdapter({ 'a.json': 'old' });
		const originalRename = vi.mocked(fs.adapter.rename).getMockImplementation()!;
		let renameCount = 0;
		vi.mocked(fs.adapter.rename).mockImplementation(async (oldPath: string, newPath: string) => {
			renameCount += 1;
			await originalRename(oldPath, newPath);
			if (renameCount === 1) fs.textFiles['a.json'] = 'remote';
		});

		await expect(
			transactionalWriteText(fs.adapter, 'a.json', 'local', undefined, 'old'),
		).rejects.toThrow('Concurrent text write detected after claim');
		expect(fs.textFiles['a.json']).toBe('remote');
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

describe('transactionalModifyVaultBinary', () => {
	it('restores the tracked PDF when dependent sidecar cleanup fails', async () => {
		const fs = makeAdapter();
		const file = { path: 'a.pdf' } as TFile;
		let current = new Uint8Array([1, 2, 3]).buffer;
		const vault = {
			readBinary: vi.fn(async () => current.slice(0)),
			modifyBinary: vi.fn(async (_file: TFile, data: ArrayBuffer) => {
				current = data.slice(0);
			}),
		} as unknown as Vault;
		const replacement = new Uint8Array([4, 5, 6]).buffer;

		await expect(
			transactionalModifyVaultBinary(
				vault,
				fs.adapter,
				file,
				replacement,
				async (candidate) => {
					if (candidate.byteLength === 0) throw new Error('invalid');
				},
				async () => {
					throw new Error('sidecar cleanup failed');
				},
			),
		).rejects.toThrow('sidecar cleanup failed');

		expect([...new Uint8Array(current)]).toEqual([1, 2, 3]);
		expect(
			[...fs.binaryFiles.keys()].some((path) => path.startsWith('a.pdf.jot-backup-')),
		).toBe(true);
	});

	it('commits through Vault.modifyBinary and removes the recovery backup on success', async () => {
		const fs = makeAdapter();
		const file = { path: 'a.pdf' } as TFile;
		let current = new Uint8Array([1, 2, 3]).buffer;
		const vault = {
			readBinary: vi.fn(async () => current.slice(0)),
			modifyBinary: vi.fn(async (_file: TFile, data: ArrayBuffer) => {
				current = data.slice(0);
			}),
		} as unknown as Vault;
		const replacement = new Uint8Array([4, 5, 6]).buffer;

		await transactionalModifyVaultBinary(
			vault,
			fs.adapter,
			file,
			replacement,
			async () => {},
		);

		expect([...new Uint8Array(current)]).toEqual([4, 5, 6]);
		expect(
			[...fs.binaryFiles.keys()].some((path) => path.startsWith('a.pdf.jot-backup-')),
		).toBe(false);
	});
});



describe('transaction recovery', () => {
	it('restores the original text backup when a crash occurred between the two renames', async () => {
		const fs = makeAdapter({
			'a.json.jot-backup-100-1': 'old',
			'a.json.jot-tmp-100-1': 'new',
		});
		const status = await recoverInterruptedTextWrite(
			fs.adapter,
			'a.json',
			(text) => text === 'old' || text === 'new',
		);
		expect(status).toBe('restored-backup');
		expect(fs.textFiles['a.json']).toBe('old');
		expect(Object.keys(fs.textFiles).filter((path) => path.includes('.jot-'))).toEqual([]);
	});

	it('salvages a valid first-write temp when no prior authoritative file existed', async () => {
		const fs = makeAdapter({ 'new.json.jot-tmp-101-1': 'candidate' });
		const status = await recoverInterruptedTextWrite(
			fs.adapter,
			'new.json',
			(text) => text === 'candidate',
		);
		expect(status).toBe('committed-temp');
		expect(fs.textFiles['new.json']).toBe('candidate');
	});

	it('rolls back an interrupted tracked PDF overwrite when its sidecar still exists', async () => {
		const fs = makeAdapter({ 'a.pdf.jot.json': '{"version":3,"pages":{}}' });
		const original = new Uint8Array([1, 2, 3]).buffer;
		const replacement = new Uint8Array([4, 5, 6]).buffer;
		fs.binaryFiles.set('a.pdf.jot-backup-102-1', original);
		let current = replacement.slice(0);
		const file = { path: 'a.pdf' } as TFile;
		const vault = {
			readBinary: vi.fn(async () => current.slice(0)),
			modifyBinary: vi.fn(async (_file: TFile, data: ArrayBuffer) => {
				current = data.slice(0);
			}),
		} as unknown as Vault;

		const status = await recoverInterruptedVaultBinary(
			vault,
			fs.adapter,
			file,
			'a.pdf.jot.json',
			async (bytes) => {
				if (bytes.byteLength !== 3) throw new Error('invalid');
			},
		);

		expect(status).toBe('rolled-back');
		expect([...new Uint8Array(current)]).toEqual([1, 2, 3]);
		expect(fs.binaryFiles.has('a.pdf.jot-backup-102-1')).toBe(false);
	});
});
