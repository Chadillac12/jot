import { describe, expect, it } from 'vitest';
import { DocumentSessionManager } from '../src/document-session';
import { createJotNote, serializeJotNote } from '../src/jot-note-file';
import { NotebookExternalConflictError, NotebookSessionManager } from '../src/notebook-session';

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


describe('NotebookDocumentSession save serialization', () => {
	it('serializes overlapping save requests and persists the newest revision last', async () => {
		const manager = new NotebookSessionManager(new DocumentSessionManager());
		const session = manager.get('Lecture.jot');
		const initial = serializeJotNote(createJotNote());
		expect(session.load(initial)).toBe('loaded');

		let releaseFirst: () => void = () => {};
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = () => resolve();
		});
		const writes: string[] = [];
		let call = 0;
		const writer = async (_expected: string, next: string) => {
			call += 1;
			if (call === 1) await firstGate;
			writes.push(next);
		};

		session.strokes.setForKey('Lecture.jot::page-1', [
			{
				points: [{ x: 0.1, y: 0.1, pressure: 0.5 }],
				color: '#111111',
				width: 0.005,
				tool: 'pen',
				render: { version: 2, smoothing: 0.5, pressureSensitivity: 0.5 },
			},
		]);
		session.markDirty();
		const first = session.save(writer);
		// Let the first serialized save enter the writer and block on firstGate
		// before the second edit occurs.
		await Promise.resolve();
		expect(call).toBe(1);

		session.strokes.setForKey('Lecture.jot::page-1', [
			{
				points: [{ x: 0.2, y: 0.2, pressure: 0.5 }],
				color: '#222222',
				width: 0.005,
				tool: 'pen',
				render: { version: 2, smoothing: 0.5, pressureSensitivity: 0.5 },
			},
		]);
		session.markDirty();
		const second = session.save(writer);

		releaseFirst();
		expect(await first).toBe(true);
		expect(await second).toBe(true);
		expect(writes).toHaveLength(2);
		expect(writes[0]).toContain('#111111');
		expect(writes[1]).toContain('#222222');
		expect(session.state.state).toBe('clean');
	});

	it('an identical second-view load does not clear shared undo history', () => {
		const manager = new NotebookSessionManager(new DocumentSessionManager());
		const session = manager.get('Lecture.jot');
		const initial = serializeJotNote(createJotNote());
		session.load(initial);
		session.history.push({
			pdfPath: 'Lecture.jot',
			key: 'Lecture.jot::page-1',
			prevStrokes: [],
		});
		expect(session.history.canUndo('Lecture.jot')).toBe(true);

		expect(session.load(initial)).toBe('loaded');
		expect(session.history.canUndo('Lecture.jot')).toBe(true);
	});
});


describe('Notebook conflict resolution', () => {
	it('keep-local adopts the exact conflicting external bytes as the next save baseline', async () => {
		const manager = new NotebookSessionManager(new DocumentSessionManager());
		const session = manager.get('Lecture.jot');
		const initial = serializeJotNote(createJotNote());
		expect(session.load(initial)).toBe('loaded');

		session.strokes.setForKey('Lecture.jot::page-1', [
			{
				points: [{ x: 0.3, y: 0.4, pressure: 0.5 }],
				color: '#333333',
				width: 0.005,
				tool: 'pen',
				render: { version: 2, smoothing: 0.5, pressureSensitivity: 0.5 },
			},
		]);
		session.markDirty();

		const externalNote = createJotNote();
		externalNote.paper = 'grid';
		const external = serializeJotNote(externalNote);
		expect(session.load(external)).toBe('conflict');

		session.resolveConflictKeepLocal();
		session.markDirty();

		let expectedSeen = '';
		const saved = await session.save(async (expected, next) => {
			expectedSeen = expected;
			expect(next).toContain('#333333');
		});
		expect(saved).toBe(true);
		expect(expectedSeen).toBe(external);
		expect(session.state.state).toBe('clean');
	});

	it('writer-detected external conflict is retained for later keep-local resolution', async () => {
		const manager = new NotebookSessionManager(new DocumentSessionManager());
		const session = manager.get('Lecture.jot');
		const initial = serializeJotNote(createJotNote());
		session.load(initial);
		session.markDirty();
		const external = JSON.stringify({ changed: true });

		expect(
			await session.save(async () => {
				throw new NotebookExternalConflictError(external);
			}),
		).toBe(false);
		expect(session.state.state).toBe('conflict');

		session.resolveConflictKeepLocal();
		let expectedSeen = '';
		expect(
			await session.save(async (expected) => {
				expectedSeen = expected;
			}),
		).toBe(true);
		expect(expectedSeen).toBe(external);
	});
});


describe('Notebook save failure recovery', () => {
	it('keeps failed notebook writes dirty and allows a later retry to succeed', async () => {
		const manager = new NotebookSessionManager(new DocumentSessionManager());
		const session = manager.get('Lecture.jot');
		session.load(serializeJotNote(createJotNote()));
		session.markDirty();

		expect(
			await session.save(async () => {
				throw new Error('injected notebook write failure');
			}),
		).toBe(false);
		expect(session.state.state).toBe('error');
		expect(session.state.isDirty).toBe(true);

		let wrote = false;
		expect(
			await session.save(async () => {
				wrote = true;
			}),
		).toBe(true);
		expect(wrote).toBe(true);
		expect(session.state.state).toBe('clean');
	});
});
