import { describe, expect, it } from 'vitest';
import { DocumentSession, DocumentSessionManager } from '../src/document-session';

describe('DocumentSession state machine', () => {
	it('blocks reload while dirty', () => {
		const session = new DocumentSession('a.pdf');
		const load = session.beginLoad()!;
		expect(load).not.toBeNull();
		expect(session.completeLoad(load)).toBe(true);
		session.markDirty();
		expect(session.state).toBe('dirty');
		expect(session.canReload()).toBe(false);
		expect(session.beginLoad()).toBeNull();
	});

	it('rejects a load completion when a new edit arrives after the load began', () => {
		const session = new DocumentSession('a.pdf');
		const initial = session.beginLoad()!;
		expect(session.completeLoad(initial)).toBe(true);

		const reload = session.beginLoad()!;
		session.markDirty();

		expect(session.completeLoad(reload)).toBe(false);
		expect(session.isDirty).toBe(true);
		expect(session.state).toBe('dirty');
	});

	it('tracks an edit that arrives during an in-flight save', () => {
		const session = new DocumentSession('a.pdf');
		const load = session.beginLoad()!;
		session.completeLoad(load);
		session.markDirty();
		const token = session.beginSave();
		expect(token).not.toBeNull();
		session.markDirty();
		session.completeSave(token!);
		expect(session.isDirty).toBe(true);
		expect(session.state).toBe('dirty');
	});

	it('permits only one in-flight save per document', () => {
		const session = new DocumentSession('a.pdf');
		const load = session.beginLoad()!;
		session.completeLoad(load);
		session.markDirty();
		const first = session.beginSave();
		expect(first).not.toBeNull();
		expect(session.beginSave()).toBeNull();
		session.completeSave(first!);
	});

	it('keeps a failed revision dirty and retryable', () => {
		const session = new DocumentSession('a.pdf');
		const load = session.beginLoad()!;
		session.completeLoad(load);
		session.markDirty();
		const token = session.beginSave()!;
		session.failSave(token, new Error('disk full'));
		expect(session.isDirty).toBe(true);
		expect(session.state).toBe('error');
		expect(session.error?.message).toBe('disk full');
		expect(session.beginSave()).not.toBeNull();
	});

	it('prevents save while an external conflict is unresolved', () => {
		const session = new DocumentSession('a.pdf');
		const load = session.beginLoad()!;
		session.completeLoad(load);
		session.markDirty();
		session.markConflict(new Error('external edit'));
		expect(session.state).toBe('conflict');
		expect(session.beginSave()).toBeNull();
		session.resolveConflictKeepLocal();
		expect(session.beginSave()).not.toBeNull();
	});

	it('renames a manager-owned session without duplicating it', () => {
		const manager = new DocumentSessionManager();
		const session = manager.get('Old/a.pdf');
		manager.rename('Old/a.pdf', 'New/a.pdf');
		expect(manager.peek('Old/a.pdf')).toBeNull();
		expect(manager.get('New/a.pdf')).toBe(session);
		expect(session.path).toBe('New/a.pdf');
	});
});
