import { describe, expect, it } from 'vitest';
import {
	JOT_NOTE_FORMAT_VERSION,
	createJotNote,
	nextPageId,
	parseJotNoteText,
	parseJotNoteTextResult,
	serializeJotNote,
} from '../src/jot-note-file';

describe('Jot note file format', () => {
	it('creates a ruled single-page notebook by default', () => {
		const note = createJotNote();
		expect(note).toMatchObject({
			version: JOT_NOTE_FORMAT_VERSION,
			type: 'notebook',
			paper: 'ruled',
		});
		expect(note.pages).toHaveLength(1);
		expect(note.pages[0]?.id).toBe('page-1');
	});

	it('round-trips normalized strokes without changing them', () => {
		const note = createJotNote();
		note.pages[0]!.strokes.push({
			tool: 'pen',
			color: '#123456',
			width: 0.0025,
			render: { version: 2, smoothing: 0.5, pressureSensitivity: 0.5 },
			points: [
				{ x: 0.1, y: 0.2, pressure: 0.3 },
				{ x: 0.4, y: 0.5, pressure: 0.8 },
			],
		});
		const parsed = parseJotNoteText(serializeJotNote(note));
		expect(parsed).toEqual(note);
	});

	it('creates a new note only for a genuinely empty file', () => {
		expect(parseJotNoteText('')?.pages).toHaveLength(1);
		expect(parseJotNoteText('   ')?.pages).toHaveLength(1);
	});

	it('rejects malformed JSON instead of replacing it with a blank note', () => {
		expect(parseJotNoteText('{broken')).toBeNull();
		const result = parseJotNoteTextResult('{broken');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('invalid-json');
	});

	it('rejects an unsupported future notebook version', () => {
		const result = parseJotNoteTextResult(
			JSON.stringify({
				version: JOT_NOTE_FORMAT_VERSION + 1,
				type: 'notebook',
				paper: 'ruled',
				pages: [],
			}),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('unsupported-version');
	});

	it('rejects malformed point data instead of partially loading it', () => {
		const result = parseJotNoteTextResult(
			JSON.stringify({
				version: JOT_NOTE_FORMAT_VERSION,
				type: 'notebook',
				paper: 'ruled',
				pages: [
					{
						id: 'page-1',
						width: 1536,
						height: 2048,
						strokes: [
							{
								points: [{ x: 'bad', y: 0.5, pressure: 0.5 }],
								color: '#000000',
								width: 0.0025,
								tool: 'pen',
							},
						],
					},
				],
			}),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('invalid-schema');
	});

	it('rejects page ids containing the document-key separator', () => {
		const result = parseJotNoteTextResult(
			JSON.stringify({
				version: JOT_NOTE_FORMAT_VERSION,
				type: 'notebook',
				paper: 'ruled',
				pages: [
					{ id: 'page::1', width: 1536, height: 2048, strokes: [] },
				],
			}),
		);
		expect(result.ok).toBe(false);
	});

	it('rejects duplicate page ids that would collide in the stroke store', () => {
		const result = parseJotNoteTextResult(
			JSON.stringify({
				version: JOT_NOTE_FORMAT_VERSION,
				type: 'notebook',
				paper: 'ruled',
				pages: [
					{ id: 'page-1', width: 1536, height: 2048, strokes: [] },
					{ id: 'page-1', width: 1536, height: 2048, strokes: [] },
				],
			}),
		);
		expect(result.ok).toBe(false);
	});

	it('migrates missing page dimensions and legacy stroke style fields to safe defaults', () => {
		const parsed = parseJotNoteText(
			JSON.stringify({
				version: JOT_NOTE_FORMAT_VERSION,
				type: 'notebook',
				paper: 'grid',
				pages: [
					{
						strokes: [
							{
								points: [{ x: 0.25, y: 0.75, pressure: 0.5 }],
							},
						],
					},
				],
			}),
		);
		expect(parsed?.paper).toBe('grid');
		expect(parsed?.pages[0]).toMatchObject({
			id: 'page-1',
			width: 1536,
			height: 2048,
		});
		expect(parsed?.pages[0]?.strokes[0]).toMatchObject({
			tool: 'pen',
			color: '#000000',
			width: 0.0025,
		});
	});

	it('allocates page IDs without colliding with existing pages', () => {
		const note = createJotNote();
		note.pages.push({ ...note.pages[0]!, id: 'page-2', strokes: [] });
		note.pages.push({ ...note.pages[0]!, id: 'page-4', strokes: [] });
		expect(nextPageId(note.pages)).toBe('page-5');
	});
});
