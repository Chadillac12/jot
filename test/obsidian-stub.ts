export class App {}

export class Modal {
	constructor(_app: App) {}
}

export class Notice {
	constructor(_message: string, _timeout?: number) {}
}

export class ColorComponent {}

export class PluginSettingTab {
	constructor(..._args: unknown[]) {}
}

export class Setting {
	constructor(..._args: unknown[]) {}
}

export function setIcon(_element: HTMLElement, _icon: string): void {}
