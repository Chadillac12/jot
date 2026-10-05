import { describe, expect, it } from 'vitest';
import { DocumentSessionManager } from '../src/document-session';
import { createJotNote, serializeJotNote } from '../src/jot-note-file';
import { NotebookSessionManager } from '../src/notebook-session';

describe('NotebookSessionManager', () => {
	it('returns one authoritative notebook model for every view of a path', () => {
		const manager = new NotebookSessionManager(new DocumentSessionManager());
		const a = manager.get('Lecture.jot');
		const b = manager.get('Lecture.jot');
		expect(b).toBe(a);
		expect(b.strokes).toBe(a.strokes);
		expect(b.history).toBe(a.history);
	});

	it('blocks external reload from replacing dirty local ink', () => {
		const manager = new NotebookSessionManager(new DocumentSessionManager());
		const session = manager.get('Lecture.jot');
		const initial = serializeJotNote(createJotNote());
		expect(session.load(initial)).toBe('loaded');
		session.strokes.setForKey('Lecture.jot::page-1', [
			{
				points: [{ x: 0.1, y: 0.2, pressure: 0.5 }],
				color: '#123456',
				width: 0.005,
				tool: 'pen',
				render: { version: 2, smoothing: 0.5, pressureSensitivity: 0.5 },
			},
		]);
		session.markDirty();

		const external = createJotNote();
		external.paper = 'grid';
		expect(session.load(serializeJotNote(external))).toBe('conflict');
		expect(session.strokes.forKey('Lecture.jot::page-1')).toHaveLength(1);
		expect(session.state.state).toBe('conflict');
	});

	it('rekeys the one shared model when the notebook is renamed', () => {
		const manager = new NotebookSessionManager(new DocumentSessionManager());
		const session = manager.get('Old/Lecture.jot');
		session.load(serializeJotNote(createJotNote()));
		session.strokes.setForKey('Old/Lecture.jot::page-1', []);
		const renamed = manager.rename('Old/Lecture.jot', 'New/Lecture.jot');
		expect(renamed).toBe(session);
		expect(session.path).toBe('New/Lecture.jot');
		expect(manager.get('New/Lecture.jot')).toBe(session);
	});
});
