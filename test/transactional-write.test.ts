/* eslint-disable @typescript-eslint/unbound-method, obsidianmd/no-tfile-tfolder-cast */
import type { DataAdapter, TFile, Vault } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import {
	TransactionConflictError,
	binaryFingerprint,
	recoverInterruptedTextWrite,
	recoverInterruptedVaultBinary,
	transactionalModifyVaultBinary,
	transactionalRemoveTextExpected,
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
		list: vi.fn(async (folder: string) => {
			const prefix = folder ? folder + '/' : '';
			const files = [
				...Object.keys(textFiles),
				...binaryFiles.keys(),
			].filter((path) => {
				if (!path.startsWith(prefix)) return false;
				return !path.slice(prefix.length).includes('/');
			});
			return { files, folders: [] };
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

describe('transaction recovery', () => {
	it('preserves a distinct interrupted text backup when the canonical file is already valid', async () => {
		const fs = makeAdapter({
			'a.json': 'current',
			'a.json.jot-backup-100-1': 'older but distinct',
		});

		const result = await recoverInterruptedTextWrite(
			fs.adapter,
			'a.json',
			(candidate) => candidate.length > 0,
		);

		expect(result).toBe('preserved');
		expect(fs.textFiles['a.json']).toBe('current');
		expect(
			Object.keys(fs.textFiles).some((path) =>
				path.startsWith('a.json.recovery-jot-backup-100-1'),
			),
		).toBe(true);
	});

	it('cleans an interrupted text artifact only when it exactly duplicates the canonical file', async () => {
		const fs = makeAdapter({
			'a.json': 'same',
			'a.json.jot-backup-100-1': 'same',
		});

		const result = await recoverInterruptedTextWrite(
			fs.adapter,
			'a.json',
			(candidate) => candidate === 'same',
		);

		expect(result).toBe('cleaned');
		expect(Object.keys(fs.textFiles)).toEqual(['a.json']);
	});

	it('restores a verified backup when an interrupted text transaction left the canonical path missing', async () => {
		const fs = makeAdapter({
			'a.json.jot-backup-100-1': 'old',
			'a.json.jot-tmp-100-1': 'new',
		});

		const result = await recoverInterruptedTextWrite(
			fs.adapter,
			'a.json',
			(candidate) => candidate === 'old' || candidate === 'new',
		);

		expect(result).toBe('restored-backup');
		expect(fs.textFiles['a.json']).toBe('old');
		expect(Object.keys(fs.textFiles).filter((path) => path.includes('jot-'))).toEqual([]);
	});

	it('rolls back an interrupted PDF overwrite when its annotation sidecar still exists', async () => {
		const replacement = new Uint8Array([4, 5, 6]).buffer;
		const fs = makeAdapter({
			'a.pdf.jot.json': '{"version":3,"pages":{}}',
			'a.pdf.jot-txn-100-1': JSON.stringify({
				version: 1,
				replacementFingerprint: binaryFingerprint(replacement),
			}),
		});
		fs.binaryFiles.set('a.pdf.jot-backup-100-1', new Uint8Array([1, 2, 3]).buffer);
		const file = { path: 'a.pdf' } as TFile;
		let current = replacement.slice(0);
		const vault = {
			readBinary: vi.fn(async () => current.slice(0)),
			modifyBinary: vi.fn(async (_file: TFile, data: ArrayBuffer) => {
				current = data.slice(0);
			}),
		} as unknown as Vault;

		const result = await recoverInterruptedVaultBinary(
			vault,
			fs.adapter,
			file,
			async (candidate) => {
				if (candidate.byteLength === 0) throw new Error('invalid');
			},
			'a.pdf.jot.json',
		);

		expect(result).toBe('rolled-back');
		expect([...new Uint8Array(current)]).toEqual([1, 2, 3]);
		expect(fs.binaryFiles.has('a.pdf.jot-backup-100-1')).toBe(false);
	});

	it('rolls back an interrupted PDF overwrite when the sidecar is quarantined mid-delete', async () => {
		const replacement = new Uint8Array([4, 5, 6]).buffer;
		const fs = makeAdapter({
			'a.pdf.jot.json.jot-backup-100-2': '{"version":3,"pages":{"1":[]}}',
			'a.pdf.jot-txn-100-1': JSON.stringify({
				version: 1,
				replacementFingerprint: binaryFingerprint(replacement),
			}),
		});
		fs.binaryFiles.set('a.pdf.jot-backup-100-1', new Uint8Array([1, 2, 3]).buffer);
		const file = { path: 'a.pdf' } as TFile;
		let current = replacement.slice(0);
		const vault = {
			readBinary: vi.fn(async () => current.slice(0)),
			modifyBinary: vi.fn(async (_file: TFile, data: ArrayBuffer) => {
				current = data.slice(0);
			}),
		} as unknown as Vault;

		const result = await recoverInterruptedVaultBinary(
			vault,
			fs.adapter,
			file,
			async (candidate) => {
				if (candidate.byteLength === 0) throw new Error('invalid');
			},
			'a.pdf.jot.json',
		);

		expect(result).toBe('rolled-back');
		expect([...new Uint8Array(current)]).toEqual([1, 2, 3]);
	});

	it('preserves an unknown current PDF instead of rolling an old backup over it', async () => {
		const intendedReplacement = new Uint8Array([4, 5, 6]).buffer;
		const fs = makeAdapter({
			'a.pdf.jot.json': '{"version":3,"pages":{}}',
			'a.pdf.jot-txn-100-1': JSON.stringify({
				version: 1,
				replacementFingerprint: binaryFingerprint(intendedReplacement),
			}),
		});
		fs.binaryFiles.set('a.pdf.jot-backup-100-1', new Uint8Array([1, 2, 3]).buffer);
		const file = { path: 'a.pdf' } as TFile;
		let current = new Uint8Array([9, 9, 9]).buffer;
		const vault = {
			readBinary: vi.fn(async () => current.slice(0)),
			modifyBinary: vi.fn(async (_file: TFile, data: ArrayBuffer) => {
				current = data.slice(0);
			}),
		} as unknown as Vault;

		const result = await recoverInterruptedVaultBinary(
			vault,
			fs.adapter,
			file,
			async (candidate) => {
				if (candidate.byteLength === 0) throw new Error('invalid');
			},
			'a.pdf.jot.json',
		);

		expect(result).toBe('external-preserved');
		expect([...new Uint8Array(current)]).toEqual([9, 9, 9]);
		expect(vault.modifyBinary).not.toHaveBeenCalled();
		expect(
			[...fs.binaryFiles.keys()].some((path) => path.startsWith('a.pdf.recovery-')),
		).toBe(true);
	});

	it('finalizes an interrupted PDF overwrite when sidecar cleanup already completed', async () => {
		const replacement = new Uint8Array([4, 5, 6]).buffer;
		const fs = makeAdapter({
			'a.pdf.jot-txn-100-1': JSON.stringify({
				version: 1,
				replacementFingerprint: binaryFingerprint(replacement),
			}),
		});
		fs.binaryFiles.set('a.pdf.jot-backup-100-1', new Uint8Array([1, 2, 3]).buffer);
		const file = { path: 'a.pdf' } as TFile;
		let current = replacement.slice(0);
		const vault = {
			readBinary: vi.fn(async () => current.slice(0)),
			modifyBinary: vi.fn(async (_file: TFile, data: ArrayBuffer) => {
				current = data.slice(0);
			}),
		} as unknown as Vault;

		const result = await recoverInterruptedVaultBinary(
			vault,
			fs.adapter,
			file,
			async (candidate) => {
				if (candidate.byteLength === 0) throw new Error('invalid');
			},
			'a.pdf.jot.json',
		);

		expect(result).toBe('finalized');
		expect([...new Uint8Array(current)]).toEqual([4, 5, 6]);
		expect(fs.binaryFiles.has('a.pdf.jot-backup-100-1')).toBe(false);
	});
});

describe('transactionalRemoveTextExpected', () => {
	it('refuses to delete a file that no longer matches the verified baseline', async () => {
		const fs = makeAdapter({ 'a.json': 'remote' });

		await expect(
			transactionalRemoveTextExpected(fs.adapter, 'a.json', 'old'),
		).rejects.toBeInstanceOf(TransactionConflictError);

		expect(fs.textFiles['a.json']).toBe('remote');
		expect(Object.keys(fs.textFiles).filter((path) => path.includes('jot-backup'))).toEqual([]);
	});

	it('deletes only the quarantined baseline and preserves a synced replacement', async () => {
		const fs = makeAdapter({ 'a.json': 'old' });
		const originalRename = vi.mocked(fs.adapter.rename).getMockImplementation()!;
		let injected = false;
		vi.mocked(fs.adapter.rename).mockImplementation(async (oldPath: string, newPath: string) => {
			await originalRename(oldPath, newPath);
			if (!injected && oldPath === 'a.json' && newPath.includes('.jot-backup-')) {
				injected = true;
				fs.textFiles['a.json'] = 'new remote';
			}
		});

		await transactionalRemoveTextExpected(fs.adapter, 'a.json', 'old');

		expect(fs.textFiles['a.json']).toBe('new remote');
		expect(Object.keys(fs.textFiles).filter((path) => path.includes('jot-backup'))).toEqual([]);
	});
});

describe('transactionalWriteText', () => {
	it('commits a verified replacement and removes temporary artifacts', async () => {
		const fs = makeAdapter({ 'a.json': 'old' });
		await transactionalWriteText(fs.adapter, 'a.json', 'new');
		expect(fs.textFiles['a.json']).toBe('new');
		expect(Object.keys(fs.textFiles).filter((path) => path.includes('jot-'))).toEqual([]);
	});

	it('restores an externally changed original instead of overwriting past the expected baseline', async () => {
		const fs = makeAdapter({ 'a.json': 'old' });
		const originalWrite = vi.mocked(fs.adapter.write).getMockImplementation()!;
		vi.mocked(fs.adapter.write).mockImplementation(async (path: string, data: string) => {
			await originalWrite(path, data);
			if (path.includes('.jot-tmp-')) fs.textFiles['a.json'] = 'remote';
		});

		await expect(
			transactionalWriteText(fs.adapter, 'a.json', 'local', undefined, 'old'),
		).rejects.toBeInstanceOf(TransactionConflictError);
		expect(fs.textFiles['a.json']).toBe('remote');
		expect(Object.keys(fs.textFiles).filter((path) => path.includes('jot-'))).toEqual([]);
	});

	it('never deletes a synced file that replaces the committed local write before verification', async () => {
		const fs = makeAdapter({ 'a.json': 'old' });
		const originalRename = vi.mocked(fs.adapter.rename).getMockImplementation()!;
		vi.mocked(fs.adapter.rename).mockImplementation(async (oldPath: string, newPath: string) => {
			await originalRename(oldPath, newPath);
			if (oldPath.includes('.jot-tmp-') && newPath === 'a.json') {
				fs.textFiles['a.json'] = 'remote after commit';
			}
		});

		await expect(
			transactionalWriteText(fs.adapter, 'a.json', 'local', undefined, 'old'),
		).rejects.toThrow('Committed write validation failed');

		expect(fs.textFiles['a.json']).toBe('remote after commit');
		expect(
			Object.keys(fs.textFiles).some((path) => path.startsWith('a.json.conflict-')),
		).toBe(true);
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
	it('refuses to create a copy over a file that appears after the transaction starts', async () => {
		const fs = makeAdapter();
		const replacement = new Uint8Array([4, 5, 6]).buffer;
		const originalWriteBinary = vi.mocked(fs.adapter.writeBinary).getMockImplementation()!;
		vi.mocked(fs.adapter.writeBinary).mockImplementation(async (path: string, data: ArrayBuffer) => {
			await originalWriteBinary(path, data);
			if (path.includes('.jot-tmp-')) {
				fs.binaryFiles.set('new.pdf', new Uint8Array([9, 9, 9]).buffer);
			}
		});

		await expect(
			transactionalWriteBinary(
				fs.adapter,
				'new.pdf',
				replacement,
				async () => {},
				undefined,
				null,
			),
		).rejects.toBeInstanceOf(TransactionConflictError);

		expect([...new Uint8Array(fs.binaryFiles.get('new.pdf')!)]).toEqual([9, 9, 9]);
	});

	it('preserves a synced copy target that replaces Jot’s bytes before verification', async () => {
		const fs = makeAdapter();
		const replacement = new Uint8Array([4, 5, 6]).buffer;
		const originalRename = vi.mocked(fs.adapter.rename).getMockImplementation()!;
		vi.mocked(fs.adapter.rename).mockImplementation(async (oldPath: string, newPath: string) => {
			await originalRename(oldPath, newPath);
			if (oldPath.includes('.jot-tmp-') && newPath === 'new.pdf') {
				fs.binaryFiles.set('new.pdf', new Uint8Array([8, 8, 8]).buffer);
			}
		});

		await expect(
			transactionalWriteBinary(
				fs.adapter,
				'new.pdf',
				replacement,
				async () => {},
				undefined,
				null,
			),
		).rejects.toBeInstanceOf(TransactionConflictError);

		expect([...new Uint8Array(fs.binaryFiles.get('new.pdf')!)]).toEqual([8, 8, 8]);
	});

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

	it('blocks overwrite when the PDF changed after merge input was captured', async () => {
		const fs = makeAdapter();
		const file = { path: 'a.pdf' } as TFile;
		const expected = new Uint8Array([1, 2, 3]).buffer;
		let current = new Uint8Array([7, 8, 9]).buffer;
		const vault = {
			readBinary: vi.fn(async () => current.slice(0)),
			modifyBinary: vi.fn(async (_file: TFile, data: ArrayBuffer) => {
				current = data.slice(0);
			}),
		} as unknown as Vault;

		await expect(
			transactionalModifyVaultBinary(
				vault,
				fs.adapter,
				file,
				new Uint8Array([4, 5, 6]).buffer,
				async () => {},
				undefined,
				expected,
			),
		).rejects.toBeInstanceOf(TransactionConflictError);

		expect([...new Uint8Array(current)]).toEqual([7, 8, 9]);
		expect(vault.modifyBinary).not.toHaveBeenCalled();
	});

	it('preserves an external PDF that replaces Jot’s committed bytes before verification', async () => {
		const fs = makeAdapter();
		const file = { path: 'a.pdf' } as TFile;
		const original = new Uint8Array([1, 2, 3]).buffer;
		const replacement = new Uint8Array([4, 5, 6]).buffer;
		let current = original.slice(0);
		const vault = {
			readBinary: vi.fn(async () => current.slice(0)),
			modifyBinary: vi.fn(async (_file: TFile, _data: ArrayBuffer) => {
				current = new Uint8Array([9, 9, 9]).buffer;
			}),
		} as unknown as Vault;

		await expect(
			transactionalModifyVaultBinary(
				vault,
				fs.adapter,
				file,
				replacement,
				async () => {},
				undefined,
				original,
			),
		).rejects.toThrow('external PDF was preserved');

		expect([...new Uint8Array(current)]).toEqual([9, 9, 9]);
		expect(
			[...fs.binaryFiles.keys()].some((path) => path.startsWith('a.pdf.recovery-')),
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

