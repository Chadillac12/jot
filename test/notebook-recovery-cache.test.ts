import { describe, expect, it } from 'vitest';
import { reusableRecoveryPath, type NotebookRecoveryRecord } from '../src/notebook-recovery-cache';

describe('DER notebook rename conflict recovery', () => {
	it('reuses an existing durable copy instead of classifying it as recovery failure', () => {
		const records = new Map<string, NotebookRecoveryRecord>([
			['New.jot', { revision: 5, path: 'New.local-conflict-2026.jot' }],
		]);
		expect(reusableRecoveryPath(records, 'New.jot', 5, (path) => path === 'New.local-conflict-2026.jot'))
			.toBe('New.local-conflict-2026.jot');
	});

	it('requires a new copy if the prior one was lost or the revision advanced', () => {
		const records = new Map<string, NotebookRecoveryRecord>([
			['New.jot', { revision: 5, path: 'Missing.jot' }],
		]);
		expect(reusableRecoveryPath(records, 'New.jot', 5, () => false)).toBeNull();
		expect(reusableRecoveryPath(records, 'New.jot', 6, () => true)).toBeNull();
	});
});
