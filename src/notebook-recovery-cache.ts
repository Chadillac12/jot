export interface NotebookRecoveryRecord {
	revision: number;
	path: string;
}

/**
 * A previously created recovery copy remains valid for the same revision.
 * Returning null only means a new durable copy must be created.
 */
export function reusableRecoveryPath(
	records: ReadonlyMap<string, NotebookRecoveryRecord>,
	sessionPath: string,
	revision: number,
	exists: (path: string) => boolean,
): string | null {
	const prior = records.get(sessionPath);
	if (!prior || prior.revision !== revision) return null;
	return exists(prior.path) ? prior.path : null;
}
