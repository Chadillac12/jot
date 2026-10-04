import { describe, expect, it } from 'vitest';
import { DocumentSessionManager } from '../src/document-session';

describe('DocumentSession', () => {
	it('prevents disk reload while local state is dirty', () => {
		const manager = new DocumentSessionManager();
		const session = manager.pdf('a.pdf');
		expect(session.beginLoad()).toBe(true);
		session.completeLoad();
		session.markDirty();
		expect(session.canReload).toBe(false);
		expect(session.beginLoad()).toBe(false);
	});

	it('tracks edits that occur during an in-flight save', () => {
		const manager = new DocumentSessionManager();
		const session = manager.pdf('a.pdf');
		session.beginLoad();
		session.completeLoad();
		session.markDirty();
		const savedRevision = session.beginSave();
		expect(savedRevision).toBe(1);
		session.markDirty();
		session.saveSucceeded(savedRevision!);
		expect(session.state).toBe('dirty');
		expect(session.revision).toBe(2);
		expect(session.persistedRevision).toBe(1);
	});

	it('keeps failed saves dirty and retryable', () => {
		const manager = new DocumentSessionManager();
		const session = manager.pdf('a.pdf');
		session.beginLoad();
		session.completeLoad();
		session.markDirty();
		const revision = session.beginSave();
		session.saveFailed(new Error('disk full'));
		expect(session.state).toBe('save-error');
		expect(session.lastError).toBe('disk full');
		expect(session.isDirty).toBe(true);
		expect(session.beginSave()).toBe(revision);
	});

	it('moves authoritative ink and undo ownership on rename', () => {
		const manager = new DocumentSessionManager();
		const session = manager.pdf('Old/a.pdf');
		manager.strokes.setForKey('Old/a.pdf::1', [
			{ points: [{ x: 0.1, y: 0.1, pressure: 0.5 }], color: '#000000', width: 0.0025, tool: 'pen' },
		]);
		manager.history.push({ pdfPath: 'Old/a.pdf', key: 'Old/a.pdf::1', prevStrokes: [] });

		manager.rename('Old/a.pdf', 'New/a.pdf');

		expect(session.path).toBe('New/a.pdf');
		expect(manager.strokes.forKey('New/a.pdf::1')).toHaveLength(1);
		expect(manager.strokes.forKey('Old/a.pdf::1')).toHaveLength(0);
		expect(manager.history.canUndo('New/a.pdf')).toBe(true);
		expect(manager.history.canUndo('Old/a.pdf')).toBe(false);
	});
});

describe('NotebookDocumentSession', () => {
	it('shares one notebook model for repeated requests of the same path', () => {
		const manager = new DocumentSessionManager();
		expect(manager.notebook('Lecture.jot')).toBe(manager.notebook('Lecture.jot'));
	});

	it('does not replace dirty notebook state with an external reload', () => {
		const manager = new DocumentSessionManager();
		const session = manager.notebook('Lecture.jot');
		const original = JSON.stringify({
			version: 1,
			type: 'notebook',
			paper: 'ruled',
			pages: [{ id: 'page-1', width: 1536, height: 2048, strokes: [] }],
		});
		expect(session.loadText(original)).toBe('loaded');
		session.markDirty();

		const external = original.replace('"ruled"', '"grid"');
		expect(session.loadText(external)).toBe('conflict');
		expect(session.state).toBe('conflict');
		expect(session.note.paper).toBe('ruled');
	});

	it('serializes the shared stroke store rather than a view-local copy', () => {
		const manager = new DocumentSessionManager();
		const session = manager.notebook('Lecture.jot');
		session.loadText(JSON.stringify({
			version: 1,
			type: 'notebook',
			paper: 'ruled',
			pages: [{ id: 'page-1', width: 1536, height: 2048, strokes: [] }],
		}));
		manager.strokes.setForKey('Lecture.jot::page-1', [
			{ points: [{ x: 0.2, y: 0.3, pressure: 0.7 }], color: '#123456', width: 0.0025, tool: 'pen' },
		]);

		const serialized = JSON.parse(session.serializeCurrent()) as {
			pages: Array<{ strokes: Array<{ color: string }> }>;
		};
		expect(serialized.pages[0]?.strokes[0]?.color).toBe('#123456');
	});
});


describe('conflict versus dirty invariants', () => {
	it('does not treat a validation-only conflict as locally dirty', () => {
		const manager = new DocumentSessionManager();
		const session = manager.notebook('Broken.jot');
		const result = session.loadText('{broken');
		expect(result).toBe('invalid');
		expect(session.state).toBe('conflict');
		expect(session.isDirty).toBe(false);
		expect(session.beginSave()).toBeNull();
	});

	it('keeps a conflict dirty when unsaved local edits exist', () => {
		const manager = new DocumentSessionManager();
		const session = manager.notebook('Lecture.jot');
		const original = JSON.stringify({
			version: 1,
			type: 'notebook',
			paper: 'ruled',
			pages: [{ id: 'page-1', width: 1536, height: 2048, strokes: [] }],
		});
		session.loadText(original);
		session.markDirty();
		expect(session.loadText(original.replace('"ruled"', '"grid"'))).toBe('conflict');
		expect(session.state).toBe('conflict');
		expect(session.isDirty).toBe(true);
		expect(session.beginSave()).toBe(session.revision);
	});
});
