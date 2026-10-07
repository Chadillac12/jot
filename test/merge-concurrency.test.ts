import type { App, DataAdapter } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { MergeService } from '../src/merge-service';
import type { PdfInsertedPageStore } from '../src/pdf-inserted-page-store';
import type { SidecarStore } from '../src/sidecar-store';
import type { StrokeStore } from '../src/stroke-store';
import type { UndoHistory } from '../src/undo';

describe('PDF merge exclusivity', () => {
	it('allows only one merge transaction for a given PDF at a time', async () => {
		let releaseFlush: (value: boolean) => void = () => {};
		const firstFlush = new Promise<boolean>((resolve) => { releaseFlush = resolve; });
		const flush = vi.fn().mockReturnValueOnce(firstFlush);
		const sidecar = { flush } as unknown as SidecarStore;
		const service = new MergeService(
			{} as App,
			{} as DataAdapter,
			{} as StrokeStore,
			{} as PdfInsertedPageStore,
			sidecar,
			{} as UndoHistory,
			{ prepareForMerge: async () => true, refreshOverlays: () => {} },
		);
		const internals = service as unknown as {
			run: (path: string, choice: 'copy', target: string) => Promise<void>;
			writeMerged: (path: string, choice: 'copy', target: string) => Promise<string>;
		};
		const writeMerged = vi.fn(async () => 'a.annotated.pdf');
		internals.writeMerged = writeMerged;
		const first = internals.run('a.pdf', 'copy', 'a.annotated.pdf');
		await internals.run('a.pdf', 'copy', 'a.annotated.pdf');
		expect(flush).toHaveBeenCalledTimes(1);
		expect(writeMerged).not.toHaveBeenCalled();
		releaseFlush(true);
		await first;
		expect(writeMerged).toHaveBeenCalledTimes(1);
		await internals.run('a.pdf', 'copy', 'a.annotated.pdf');
		expect(flush).toHaveBeenCalledTimes(2);
	});
});
