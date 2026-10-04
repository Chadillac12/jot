import type { DataAdapter } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import {
	transactionalWriteBinary,
	transactionalWriteText,
} from '../src/transactional-write';

interface MockFs {
	text: Record<string, string>;
	binary: Record<string, ArrayBuffer>;
	adapter: DataAdapter;
	renameMock: ReturnType<typeof vi.fn<(oldPath: string, newPath: string) => Promise<void>>>;
}

function makeFs(): MockFs {
	const text: Record<string, string> = {};
	const binary: Record<string, ArrayBuffer> = {};
	const renameMock = vi.fn<(oldPath: string, newPath: string) => Promise<void>>(async (oldPath, newPath) => {
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
	});
	const adapter = {
		exists: vi.fn(async (path: string) => path in text || path in binary),
		read: vi.fn(async (path: string) => {
			if (!(path in text)) throw new Error(`missing ${path}`);
			return text[path]!;
		}),
		write: vi.fn(async (path: string, value: string) => {
			text[path] = value;
		}),
		readBinary: vi.fn(async (path: string) => {
			const value = binary[path];
			if (!value) throw new Error(`missing ${path}`);
			return value;
		}),
		writeBinary: vi.fn(async (path: string, value: ArrayBuffer) => {
			binary[path] = value.slice(0);
		}),
		rename: renameMock,
		remove: vi.fn(async (path: string) => {
			delete text[path];
			delete binary[path];
		}),
	} as unknown as DataAdapter;
	return { text, binary, adapter, renameMock };
}

describe('transactionalWriteText', () => {
	it('commits verified text and removes the old backup', async () => {
		const fs = makeFs();
		fs.text['a.txt'] = 'old';

		const result = await transactionalWriteText(
			fs.adapter,
			'a.txt',
			'new',
			(value) => {
				if (value !== 'new') throw new Error('bad data');
			},
		);

		expect(fs.text['a.txt']).toBe('new');
		expect(result.backupPath).toBeNull();
		expect(Object.keys(fs.text).some((path) => path.includes('.jot-tmp-'))).toBe(false);
		expect(Object.keys(fs.text).some((path) => path.includes('.jot-backup-'))).toBe(false);
	});

	it('leaves the authoritative original untouched when validation rejects the temp file', async () => {
		const fs = makeFs();
		fs.text['a.txt'] = 'old';

		await expect(
			transactionalWriteText(fs.adapter, 'a.txt', 'new', () => {
				throw new Error('injected validation failure');
			}),
		).rejects.toThrow('injected validation failure');

		expect(fs.text['a.txt']).toBe('old');
	});

	it('rolls back the original when the commit rename fails', async () => {
		const fs = makeFs();
		fs.text['a.txt'] = 'old';
		// First rename is original -> backup, second is temp -> authoritative.
		let renameCount = 0;
		fs.renameMock.mockImplementation(async (oldPath: string, newPath: string) => {
			renameCount += 1;
			if (renameCount === 2) throw new Error('commit failed');
			if (!(oldPath in fs.text)) throw new Error(`missing ${oldPath}`);
			fs.text[newPath] = fs.text[oldPath]!;
			delete fs.text[oldPath];
		});

		await expect(
			transactionalWriteText(fs.adapter, 'a.txt', 'new', () => {}),
		).rejects.toThrow('commit failed');

		expect(fs.text['a.txt']).toBe('old');
	});
});

describe('transaction rollback after committed verification failure', () => {
	it('removes an unverified brand-new authoritative text file', async () => {
		const fs = makeFs();
		const normalRead = vi.mocked(fs.adapter.read).getMockImplementation();
		vi.mocked(fs.adapter.read).mockImplementation(async (path: string) => {
			if (path === 'new.txt') return 'corrupt';
			if (!normalRead) throw new Error('missing read implementation');
			return normalRead(path);
		});

		await expect(
			transactionalWriteText(fs.adapter, 'new.txt', 'expected', () => {}),
		).rejects.toThrow('Committed write verification failed');

		expect(fs.text['new.txt']).toBeUndefined();
		expect(Object.keys(fs.text).some((path) => path.includes('.jot-tmp-'))).toBe(false);
	});
});

describe('transactionalWriteBinary corruption handling', () => {
	it('rejects a temporary binary write whose bytes differ from the requested payload', async () => {
		const fs = makeFs();
		fs.binary['a.bin'] = Uint8Array.from([1, 2, 3]).buffer;
		vi.mocked(fs.adapter.writeBinary).mockImplementation(async (path: string, value: ArrayBuffer) => {
			const bytes = new Uint8Array(value.slice(0));
			if (bytes.length > 0) bytes[0] = (bytes[0] ?? 0) ^ 0xff;
			fs.binary[path] = bytes.buffer;
		});

		await expect(
			transactionalWriteBinary(
				fs.adapter,
				'a.bin',
				Uint8Array.from([9, 8, 7]).buffer,
				() => {},
			),
		).rejects.toThrow('Temporary binary write verification failed');

		expect([...new Uint8Array(fs.binary['a.bin']!)]).toEqual([1, 2, 3]);
	});
});

describe('transactionalWriteBinary', () => {
	it('validates both temporary and committed binary data', async () => {
		const fs = makeFs();
		const oldData = Uint8Array.from([1, 2, 3]).buffer;
		const newData = Uint8Array.from([9, 8, 7]).buffer;
		fs.binary['a.bin'] = oldData;
		const validate = vi.fn((data: ArrayBuffer) => {
			expect([...new Uint8Array(data)]).toEqual([9, 8, 7]);
		});

		await transactionalWriteBinary(fs.adapter, 'a.bin', newData, validate);

		expect(validate).toHaveBeenCalledTimes(2);
		const committed = fs.binary['a.bin'];
		expect(committed).toBeDefined();
		expect([...new Uint8Array(committed ?? new ArrayBuffer(0))]).toEqual([9, 8, 7]);
	});
});
