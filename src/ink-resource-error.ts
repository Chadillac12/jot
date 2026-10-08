/**
 * The in-memory model cannot currently be represented by a safely readable
 * mobile Jot file. Retain dirty ink and allow the user to undo/clear; do not
 * endlessly retry identical bytes or replace the last-good file.
 */
export class InkResourceLimitError extends Error {
	constructor(message = 'Ink exceeds safe serialization limits; remove some ink and retry saving.') {
		super(message);
		this.name = 'InkResourceLimitError';
	}
}
