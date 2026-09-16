import { describe, expect, it } from 'vitest';
import { isSupportedVersion, migrateStroke, parseJotText } from '../src/jot-file';

describe('sidecar compatibility regression', () => {
	it('continues to read a version 1 Jot sidecar without changing its file format', () => {
		const parsed = parseJotText(
			JSON.stringify({
				version: 1,
				pages: {
					'1': [
						{
							points: [{ x: 0.1, y: 0.2, pressure: 0.5 }],
							color: '#123456',
							width: 0.0025,
						},
					],
				},
			}),
		);

		expect(parsed).not.toBeNull();
		expect(isSupportedVersion(parsed!.version)).toBe(true);
		expect(migrateStroke(parsed!.pages['1']![0]!).tool).toBe('pen');
	});
});
