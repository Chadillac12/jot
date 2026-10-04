import { describe, expect, it } from 'vitest';
import { DocumentSessionManager } from '../src/document-session';
import { documentPageKey } from '../src/jot-file';
import { createJotNote, serializeJotNote } from '../src/jot-note-file';
import { NotebookSessionManager } from '../src/notebook-session';

describe('NotebookSessionManager', () => {
	it('returns one authoritative model for duplicate views of the same file', () => {
		const manager = new NotebookSessionManager(new DocumentSessionManager());
		const first = manager.get('Lecture.jot');
		const second = manager.get('Lecture.jot');
		expect(second).toBe(first);
		expect(second.strokes).toBe(first.strokes);
		expect(second.history).toBe(first.history);
	});

	it('preserves local dirty ink instead of accepting an external reload', () => {
		const manager = new NotebookSessionManager(new DocumentSessionManager());
		const session = manager.get('Lecture.jot');
		const initial = createJotNote();
		expect(session.loadFromText(serializeJotNote(initial))).toBe('loaded');

		session.strokes.setForKey(documentPageKey('Lecture.jot', 'page-1'), [
			{
				points: [{ x: 0.2, y: 0.3, pressure: 0.5 }],
				color: '#000000',
				width: 0.005,
				tool: 'pen',
				render: { version: 2, smoothing: 0.5, pressureSensitivity: 0.5 },
			},
		]);
		session.markDirty();

		const remote = createJotNote();
		remote.paper = 'grid';
		expect(session.loadFromText(serializeJotNote(remote))).toBe('conflict');
		expect(session.document.state).toBe('conflict');
		expect(session.strokes.forKey('Lecture.jot::page-1')).toHaveLength(1);
		expect(session.note.paper).toBe('ruled');
	});

	it('renames one shared model and preserves all ink/history ownership', () => {
		const documents = new DocumentSessionManager();
		const manager = new NotebookSessionManager(documents);
		const session = manager.get('Old/Lecture.jot');
		session.loadFromText(serializeJotNote(createJotNote()));
		session.strokes.setForKey('Old/Lecture.jot::page-1', [
			{
				points: [{ x: 0.1, y: 0.1, pressure: 0.5 }],
				color: '#000000',
				width: 0.005,
				tool: 'pen',
				render: { version: 2, smoothing: 0.5, pressureSensitivity: 0.5 },
			},
		]);

		const renamed = manager.rename('Old/Lecture.jot', 'New/Lecture.jot');
		expect(renamed).toBe(session);
		expect(manager.get('New/Lecture.jot')).toBe(session);
		expect(session.strokes.forKey('Old/Lecture.jot::page-1')).toEqual([]);
		expect(session.strokes.forKey('New/Lecture.jot::page-1')).toHaveLength(1);
		expect(session.path).toBe('New/Lecture.jot');
	});
});
