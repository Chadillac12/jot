import {
	ButtonComponent,
	DropdownComponent,
	Notice,
	TFile,
	TextFileView,
	type IconName,
	type WorkspaceLeaf,
} from 'obsidian';
import { JOT_NOTE_VIEW_TYPE, type JotPaperStyle } from './jot-note-file';
import { JotNoteSurface } from './jot-note-surface';
import type {
	NotebookSession,
	NotebookSessionEvent,
} from './notebook-session';
import { UndoController } from './undo-controller';
import type JotPlugin from './main';

const NOTE_SAVE_RETRY_MS = 2000;

export class JotNoteView extends TextFileView {
	private session: NotebookSession | null = null;
	private surface: JotNoteSurface | null = null;
	private undoController: UndoController | null = null;
	private pagesEl: HTMLElement | null = null;
	private unsubscribeSession: (() => void) | null = null;
	private retryTimer: number | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: JotPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return JOT_NOTE_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.file?.basename ?? 'Jot note';
	}

	getIcon(): IconName {
		return 'pencil';
	}

	getViewData(): string {
		return this.session?.serialize() ?? this.data ?? '';
	}

	setViewData(data: string, clear: boolean): void {
		if (clear) this.detachViewState();
		this.data = data;

		const path = this.file?.path;
		if (!path) return;
		this.attachSession(path);
		if (!this.session) return;

		const status = this.session.loadFromText(data);
		if (status === 'error') {
			this.renderLoadError(this.session.loadError ?? 'This Jot note could not be validated.');
			return;
		}
		if (status === 'conflict') {
			new Notice(
				'Jot: this notebook changed on disk while local edits were unsaved. Local edits were kept and the session is in conflict until saved or reopened.',
				8000,
			);
		}
		this.render();
	}

	override async save(clear?: boolean): Promise<void> {
		const session = this.session;
		if (!session || session.loadError) return;

		const token = session.beginSave();
		if (!token) {
			if (session.document.state === 'conflict') {
				new Notice('Jot: this notebook has an unresolved external-edit conflict.');
			}
			return;
		}

		try {
			await super.save(clear);
			session.completeSave(token);
			this.data = session.rawData;
			this.clearRetryTimer();
			if (session.document.isDirty) this.requestSave();
		} catch (error) {
			session.failSave(token, error);
			const message = error instanceof Error ? error.message : String(error);
			new Notice(
				`Jot: notebook save failed. The shared session remains dirty and will retry. ${message}`,
				10000,
			);
			this.scheduleRetry();
			throw error;
		}
	}

	clear(): void {
		this.detachViewState();
		this.contentEl.empty();
		this.data = '';
	}

	override async onRename(file: TFile): Promise<void> {
		const oldPath = this.session?.path;
		if (oldPath && oldPath !== file.path) {
			this.session = this.plugin.notebookSessions.rename(oldPath, file.path);
		}
		await super.onRename(file);
		this.render();
	}

	getUndoController(): UndoController | null {
		return this.session?.loadError ? null : this.undoController;
	}

	redrawAll(): void {
		if (!this.session?.loadError) this.surface?.redrawAll();
	}

	private attachSession(path: string): void {
		const next = this.plugin.notebookSessions.get(path);
		if (this.session === next && this.unsubscribeSession) return;

		this.unsubscribeSession?.();
		this.session = next;
		this.unsubscribeSession = next.subscribe((event) => this.onSessionEvent(event));
	}

	private detachViewState(): void {
		this.clearRetryTimer();
		this.surface?.disconnect();
		this.surface = null;
		this.pagesEl = null;
		this.undoController = null;
		this.unsubscribeSession?.();
		this.unsubscribeSession = null;
		this.session = null;
	}

	private onSessionEvent(event: NotebookSessionEvent): void {
		if (!this.session) return;
		if (event === 'ink') {
			this.surface?.redrawAll();
			return;
		}
		if (event === 'paper') {
			this.surface?.setPaperStyle(this.session.note.paper);
			return;
		}
		if (event === 'structure' || event === 'load') {
			this.render();
		}
	}

	private render(): void {
		const session = this.session;
		if (!session) return;
		if (session.loadError) {
			this.renderLoadError(session.loadError);
			return;
		}

		this.surface?.disconnect();
		this.contentEl.empty();
		this.contentEl.addClass('jot-note-view');

		const toolbar = this.contentEl.createDiv({ cls: 'jot-note-toolbar' });
		this.renderToolbar(toolbar);

		this.pagesEl = this.contentEl.createDiv({ cls: 'jot-note-pages' });
		this.surface = new JotNoteSurface(this.pagesEl, session.strokes, (canvas) => {
			if (!this.surface || !this.undoController) return;
			this.plugin.wireInkCanvas(
				canvas,
				this.surface,
				{ scheduleSave: () => this.markDirtyAndSave() },
				this.undoController,
				session.strokes,
			);
		});

		this.undoController = new UndoController(
			session.history,
			session.strokes,
			this.surface,
			{
				activeDocumentPath: () => session.path,
				onAfterApply: () => this.markDirtyAndSave(),
			},
		);

		this.surface.render(session.note, session.path);
	}

	private renderLoadError(message: string): void {
		this.surface?.disconnect();
		this.surface = null;
		this.pagesEl = null;
		this.contentEl.empty();
		this.contentEl.addClass('jot-note-view');

		const panel = this.contentEl.createDiv({ cls: 'jot-note-load-error' });
		panel.createEl('h3', { text: 'Jot note opened read-only' });
		panel.createEl('p', { text: message });
		panel.createEl('p', {
			text: 'Jot will preserve the original file exactly and will not convert or overwrite it.',
		});
	}

	private renderToolbar(toolbar: HTMLElement): void {
		const session = this.session;
		if (!session) return;

		const paperWrap = toolbar.createDiv({ cls: 'jot-note-toolbar-group' });
		paperWrap.createSpan({ text: 'Paper' });
		new DropdownComponent(paperWrap)
			.addOption('blank', 'Blank')
			.addOption('ruled', 'Ruled')
			.addOption('grid', 'Grid')
			.addOption('dot', 'Dot')
			.setValue(session.note.paper)
			.onChange((value) => this.setPaperStyle(value as JotPaperStyle));

		new ButtonComponent(toolbar)
			.setButtonText('Add page')
			.setTooltip('Add a new handwritten page')
			.onClick(() => this.addPage());

		new ButtonComponent(toolbar)
			.setButtonText('Undo')
			.setTooltip('Undo the last ink change')
			.onClick(() => this.undoController?.undo());

		new ButtonComponent(toolbar)
			.setButtonText('Redo')
			.setTooltip('Redo the last ink change')
			.onClick(() => this.undoController?.redo());
	}

	private setPaperStyle(style: JotPaperStyle): void {
		if (!this.session || this.session.loadError) return;
		this.session.setPaperStyle(style);
		this.requestSave();
	}

	private addPage(): void {
		const session = this.session;
		if (!session || session.loadError) {
			new Notice('Jot: this notebook is read-only because its data could not be validated.');
			return;
		}
		const pageId = session.addPage();
		if (!pageId) return;
		this.requestSave();
		const pages = this.pagesEl?.querySelectorAll<HTMLElement>('.jot-note-page');
		pages?.[pages.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	private markDirtyAndSave(): void {
		if (!this.session || this.session.loadError) return;
		this.session.markDirty();
		this.requestSave();
	}

	private scheduleRetry(): void {
		this.clearRetryTimer();
		const win = this.containerEl.ownerDocument.defaultView;
		if (!win) return;
		this.retryTimer = win.setTimeout(() => {
			this.retryTimer = null;
			if (this.session?.document.isDirty) this.requestSave();
		}, NOTE_SAVE_RETRY_MS);
	}

	private clearRetryTimer(): void {
		if (this.retryTimer === null) return;
		const win = this.containerEl.ownerDocument.defaultView;
		if (win) win.clearTimeout(this.retryTimer);
		this.retryTimer = null;
	}
}
