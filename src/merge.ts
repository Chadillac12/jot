import { App, Modal } from 'obsidian';

export class ExportChoiceModal extends Modal {
	private onChoice: (choice: 'overwrite' | 'copy' | 'cancel') => void;
	private copyTarget: string;

	constructor(
		app: App,
		copyTarget: string,
		onChoice: (choice: 'overwrite' | 'copy' | 'cancel') => void,
	) {
		super(app);
		this.copyTarget = copyTarget;
		this.onChoice = onChoice;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Merge notes into PDF' });
		contentEl.createEl('p', {
			text: 'Bake the strokes for this PDF into a PDF file. The sidecar .jot.json is dropped only if you overwrite the original.',
		});
		const annotatedName = this.copyTarget.replace(/.*\//, '');
		const buttons = contentEl.createDiv({ cls: 'jot-modal-buttons' });
		const copyBtn = buttons.createEl('button', {
			text: `Save as "${annotatedName}"`,
		});
		copyBtn.classList.add('mod-cta');
		copyBtn.addEventListener('click', () => {
			this.onChoice('copy');
			this.close();
		});
		const overwriteBtn = buttons.createEl('button', {
			text: 'Overwrite original',
		});
		overwriteBtn.addEventListener('click', () => {
			this.onChoice('overwrite');
			this.close();
		});
		const cancelBtn = buttons.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => {
			this.onChoice('cancel');
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
