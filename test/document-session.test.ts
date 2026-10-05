import { describe, expect, it } from 'vitest';
import { DocumentSession, DocumentSessionManager } from '../src/document-session';

describe('DocumentSession state machine', () => {
	it('moves cleanly through load, edit, save, and clean states', () => {
		const session = new DocumentSession('a.pdf');
		expect(session.state).toBe('unloaded');
		expect(session.beginLoad()).toBe(true);
		expect(session.state).toBe('loading');
		session.completeLoad();
		expect(session.state).toBe('clean');

		const revision = session.markDirty();
		expect(session.state).toBe('dirty');
		expect(session.canReloadFromDisk).toBe(false);
		expect(session.beginSave()).toBe(revision);
		expect(session.state).toBe('saving');
		session.completeSave(revision);
		expect(session.state).toBe('clean');
		expect(session.isDirty).toBe(false);
	});

	it('keeps a newer revision dirty when an older save completes', () => {
		const session = new DocumentSession('a.pdf');
		session.beginLoad();
		session.completeLoad();
		const first = session.markDirty();
		expect(session.beginSave()).toBe(first);
		const second = session.markDirty();
		expect(second).toBeGreaterThan(first);
		session.completeSave(first);
		expect(session.state).toBe('dirty');
		expect(session.isDirty).toBe(true);
	});

	it('keeps failed saves dirty and retryable', () => {
		const session = new DocumentSession('a.pdf');
		session.beginLoad();
		session.completeLoad();
		session.markDirty();
		session.beginSave();
		session.failSave(new Error('disk full'));
		expect(session.state).toBe('error');
		expect(session.isDirty).toBe(true);
		expect(session.snapshot().lastError).toContain('disk full');
		expect(session.beginSave()).not.toBeNull();
	});

	it('blocks reload while dirty, saving, failed, or conflicted', () => {
		for (const state of ['dirty', 'saving', 'error', 'conflict'] as const) {
			const session = new DocumentSession(`${state}.pdf`);
			session.beginLoad();
			session.completeLoad();
			session.markDirty();
			if (state === 'saving') session.beginSave();
			if (state === 'error') session.failSave(new Error('fail'));
			if (state === 'conflict') session.markConflict('external edit');
			expect(session.beginLoad()).toBe(false);
		}
	});
});

describe('DocumentSessionManager', () => {
	it('returns one authoritative session per path and preserves it across rename', () => {
		const manager = new DocumentSessionManager();
		const first = manager.get('Old/a.pdf');
		expect(manager.get('Old/a.pdf')).toBe(first);
		const renamed = manager.rename('Old/a.pdf', 'New/a.pdf');
		expect(renamed).toBe(first);
		expect(first.path).toBe('New/a.pdf');
		expect(manager.get('New/a.pdf')).toBe(first);
	});
});
