import { describe, expect, it } from 'vitest';
import { PdfInsertedPageStore } from '../src/pdf-inserted-page-store';

describe('PdfInsertedPageStore', () => {
	it('preserves insertion order for pages sharing the same PDF gap', () => {
		const store = new PdfInsertedPageStore();
		const first = store.add('a.pdf', 2, 'ruled');
		const second = store.add('a.pdf', 2, 'grid');

		expect(store.all('a.pdf').map((page) => page.id)).toEqual([first.id, second.id]);
		expect(store.all('a.pdf').map((page) => page.slot)).toEqual([2, 2]);
	});

	it('updates paper without changing page identity or position', () => {
		const store = new PdfInsertedPageStore();
		const page = store.add('a.pdf', 1, 'ruled');

		expect(store.updatePaper('a.pdf', page.id, 'dot')).toBe(true);
		expect(store.all('a.pdf')[0]).toMatchObject({
			id: page.id,
			slot: 1,
			paper: 'dot',
		});
	});

	it('removes only the requested inserted page', () => {
		const store = new PdfInsertedPageStore();
		const first = store.add('a.pdf', 0);
		const second = store.add('a.pdf', 1);

		expect(store.remove('a.pdf', first.id)?.id).toBe(first.id);
		expect(store.all('a.pdf').map((page) => page.id)).toEqual([second.id]);
	});

	it('moves layout ownership with a renamed PDF', () => {
		const store = new PdfInsertedPageStore();
		const page = store.add('Old/a.pdf', 3, 'grid');

		store.rekeyDocumentPath('Old/a.pdf', 'New/a.pdf');

		expect(store.all('Old/a.pdf')).toEqual([]);
		expect(store.all('New/a.pdf')[0]).toMatchObject({
			id: page.id,
			slot: 3,
			paper: 'grid',
		});
	});
});
