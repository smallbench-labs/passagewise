import { App, FuzzyMatch, FuzzySuggestModal, Menu, Notice, Platform, Plugin, PluginSettingTab, Setting, SettingDefinitionGroup, SettingDefinitionItem, TAbstractFile, TFile, normalizePath, requestUrl, requireApiVersion } from 'obsidian';
import { BookIndex, Highlight, VaultLike } from './core/model';
import { DetectedFormat, isProFormat, parseBinaryImport, parseImport } from './core/detect';
import { dedupeHighlights } from './core/dedupe';
import { syncHighlights } from './core/notes';
import { emptyResultMessage, importSummary } from './core/summary';
import { isSqliteHeader } from './core/sqlite';
import { LicenseManager, DEFAULT_LICENSE_CONFIG } from './license/licenseManager';
import { EMPTY_LICENSE, HttpPost, LicenseCache } from './license/types';
import { KeyStore, selectKeyStore } from './license/keyStore';
import { BuyGate } from './license/buyGate';
import { CHECKOUT_READY, CHECKOUT_URL } from './license/checkout';
import { ConsentState, openCheckoutIfConsented } from './license/consent';
import { buildConsentBlock } from './license/consentUi';
import { obsidianHttpGetJson } from './license/obsidianHttp';
import { appLocalStore, buildDeviceLabel, getDeviceCode } from './license/deviceLabel';

interface Settings {
	folder: string;
	fileNameTemplate: string;
	skipBookmarks: boolean;
	openAfter: boolean;
	license: LicenseCache;
	index: BookIndex;
}

const DEFAULTS: Settings = {
	folder: 'Highlights',
	fileNameTemplate: '{{title}}',
	skipBookmarks: true,
	openAfter: true,
	license: { ...EMPTY_LICENSE },
	index: {},
};

const IMPORT_EXTENSIONS = new Set(['txt', 'html', 'htm', 'json', 'lua', 'sqlite', 'sqlite3', 'db']);
const ACCEPT = '.txt,.html,.htm,.json,.lua,.sqlite,.sqlite3,.db';
const SUPPORTED_HINT = 'Passagewise reads Kindle My Clippings.txt, Kindle notebook HTML, KOReader .lua or .json, and KoboReader.sqlite.';

const httpPost: HttpPost = async (url, body) => {
	const res = await requestUrl({ url, method: 'POST', contentType: 'application/json', body: JSON.stringify(body), throw: false });
	let json: unknown = null;
	try { json = res.json; } catch { json = null; }
	return { status: res.status, json };
};

class VaultBridge implements VaultLike {
	constructor(private app: App) {}
	async read(path: string): Promise<string | null> {
		const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
		if (file instanceof TFile) return this.app.vault.read(file);
		return null;
	}
	async write(path: string, content: string): Promise<void> {
		const normalised = normalizePath(path);
		const file = this.app.vault.getAbstractFileByPath(normalised);
		if (file instanceof TFile) {
			await this.app.vault.modify(file, content);
			return;
		}
		await this.app.vault.create(normalised, content);
	}
	async exists(path: string): Promise<boolean> {
		return this.app.vault.getAbstractFileByPath(normalizePath(path)) instanceof TFile;
	}
	async createFolder(path: string): Promise<void> {
		const normalised = normalizePath(path);
		if (!normalised || normalised === '/' || this.app.vault.getAbstractFileByPath(normalised)) return;
		const parts = normalised.split('/');
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(current)) {
				await this.app.vault.createFolder(current);
			}
		}
	}
}

/** First row opens the system file picker; the rest are export files already in the vault. */
type PickItem = { kind: 'device' } | { kind: 'vault'; file: TFile };

class ImportPickerModal extends FuzzySuggestModal<PickItem> {
	constructor(app: App, private files: TFile[], private pro: boolean, private onChoose: (item: PickItem) => void) {
		super(app);
		this.setPlaceholder('Choose a highlights file to import');
		this.setInstructions([
			{ command: '↑↓', purpose: 'to navigate' },
			{ command: '↵', purpose: 'to import' },
			{ command: 'esc', purpose: 'to dismiss' },
		]);
	}
	getItems(): PickItem[] {
		return [{ kind: 'device' }, ...this.files.map((file): PickItem => ({ kind: 'vault', file }))];
	}
	getItemText(item: PickItem): string {
		return item.kind === 'device' ? 'Choose a file on this device…' : item.file.path;
	}
	renderSuggestion(match: FuzzyMatch<PickItem>, el: HTMLElement): void {
		super.renderSuggestion(match, el);
		const item = match.item;
		const hint = item.kind === 'device'
			? (Platform.isMobile ? 'Pick an export from the Files app.' : 'For example My Clippings.txt on a connected Kindle.')
			: describeFile(item.file, this.pro);
		if (hint) el.createDiv({ cls: 'passagewise-suggestion-note', text: hint });
	}
	onChooseItem(item: PickItem): void { this.onChoose(item); }
}

function describeFile(file: TFile, pro: boolean): string {
	const name = file.name.toLowerCase();
	const ext = file.extension.toLowerCase();
	const tag = pro ? '' : ' (Pro)';
	if (/clippings/.test(name) && ext === 'txt') return 'Kindle clippings';
	if (ext === 'html' || ext === 'htm') return 'Kindle notebook (HTML)';
	if (ext === 'lua') return `KOReader${tag}`;
	if (ext === 'json') return `KOReader JSON${tag}`;
	if (ext === 'sqlite' || ext === 'sqlite3' || ext === 'db') return `Kobo database${tag}`;
	return '';
}

function sizeLabel(bytes: number): string {
	return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatLabel(format: DetectedFormat): string {
	switch (format) {
		case 'kindle-clippings': return 'Kindle clippings';
		case 'kindle-html': return 'Kindle notebook';
		case 'koreader-lua':
		case 'koreader-json': return 'KOReader';
		case 'kobo-sqlite': return 'Kobo';
		default: return 'export';
	}
}

export default class PassagewisePlugin extends Plugin {
	settings!: Settings;
	license!: LicenseManager;
	keyStore!: KeyStore;
	deviceCode = '';
	deviceLabel = '';
	private busy = false;

	async onload() {
		await this.loadSettings();
		this.deviceCode = getDeviceCode(appLocalStore(this.app));
		this.deviceLabel = buildDeviceLabel(Platform, this.deviceCode);
		this.license = new LicenseManager(this.settings.license, DEFAULT_LICENSE_CONFIG, httpPost, () => Date.now(), async (cache) => {
			this.keyStore.save(cache.key);
			this.settings.license = cache;
			await this.saveSettings();
		}, () => performance.now(), (ms) => new Promise((r) => window.setTimeout(r, ms)));
		this.license.setDeviceLabel(this.deviceLabel);

		this.addRibbonIcon('highlighter', 'Import highlights', () => this.openPicker());
		this.addCommand({
			id: 'import-highlights',
			name: 'Import highlights',
			callback: () => this.openPicker(),
		});
		this.addCommand({
			id: 'import-current-file',
			name: 'Import highlights from the current file',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !IMPORT_EXTENSIONS.has(file.extension.toLowerCase())) return false;
				if (!checking) void this.importVaultFile(file);
				return true;
			},
		});
		this.registerEvent(this.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
			if (!(file instanceof TFile) || !IMPORT_EXTENSIONS.has(file.extension.toLowerCase())) return;
			menu.addItem((item) => item.setTitle('Import highlights').setIcon('highlighter').onClick(() => void this.importVaultFile(file)));
		}));
		// Keep the book → note index in step when the user renames or moves a book note (or its folder),
		// so the next import updates the renamed note instead of creating a new one.
		this.registerEvent(this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
			let changed = false;
			for (const entry of Object.values(this.settings.index)) {
				if (entry.path === oldPath) { entry.path = file.path; changed = true; }
				else if (entry.path.startsWith(`${oldPath}/`)) { entry.path = file.path + entry.path.slice(oldPath.length); changed = true; }
			}
			if (changed) void this.saveSettings();
		}));
		this.addSettingTab(new PassagewiseSettingTab(this.app, this));
		if (this.settings.license.key) this.app.workspace.onLayoutReady(() => { void this.license.onLoad(); });
	}

	isPro(): boolean { return this.license.isPro(); }

	private importableFiles(): TFile[] {
		return this.app.vault.getFiles()
			.filter((file) => IMPORT_EXTENSIONS.has(file.extension.toLowerCase()))
			.sort((a, b) => b.stat.mtime - a.stat.mtime);
	}

	openPicker() {
		new ImportPickerModal(this.app, this.importableFiles(), this.isPro(), (item) => {
			if (item.kind === 'vault') void this.importVaultFile(item.file);
			else this.pickDeviceFile();
		}).open();
	}

	/** System file picker (desktop file dialog, Files app on iOS/Android). The file is read once and not copied into the vault. */
	pickDeviceFile() {
		activeDocument.querySelectorAll('input.passagewise-file-input').forEach((el) => el.remove());
		const input = activeDocument.body.createEl('input', { type: 'file', attr: { accept: ACCEPT }, cls: 'passagewise-file-input' });
		const cleanup = () => input.remove();
		input.addEventListener('change', () => {
			const file = input.files?.[0];
			cleanup();
			if (!file) return;
			void this.importBytes(file.name, file.size, () => file.arrayBuffer());
		}, { once: true });
		input.addEventListener('cancel', cleanup, { once: true });
		input.click();
	}

	async importVaultFile(file: TFile) {
		await this.importBytes(file.name, file.stat.size, () => this.app.vault.readBinary(file));
	}

	async importBytes(name: string, size: number, read: () => Promise<ArrayBuffer>) {
		if (this.busy) { new Notice('An import is already running.'); return; }
		this.busy = true;
		const progress = size > 512 * 1024 ? new Notice(`Importing “${name}” (${sizeLabel(size)})…`, 0) : null;
		try {
			await this.runImport(name, size, await read());
		} catch (e) {
			console.error('Passagewise import failed', e);
			new Notice(`Could not import “${name}”: ${(e as Error).message || String(e)}`, 10000);
		} finally {
			progress?.hide();
			this.busy = false;
		}
	}

	private async runImport(name: string, size: number, data: ArrayBuffer) {
		const binary = isSqliteHeader(data);
		const text = binary ? '' : new TextDecoder('utf-8').decode(data);
		if (!data.byteLength || (!binary && !text.trim())) {
			new Notice(`“${name}” is empty.`);
			return;
		}
		const { format, result } = binary ? parseBinaryImport(data, name) : parseImport(text, name);
		if (format === 'unknown' || (binary && format !== 'kobo-sqlite')) {
			new Notice(`“${name}” is not a highlights export. ${SUPPORTED_HINT}`, 10000);
			return;
		}
		if (isProFormat(format) && !this.isPro()) {
			const how = CHECKOUT_READY ? 'Add a license key in Settings → Passagewise.' : 'Pro is not on sale yet.';
			new Notice(`${formatLabel(format)} imports are part of Passagewise Pro. Kindle imports are free. ${how}`, 10000);
			return;
		}
		if (format === 'kobo-sqlite' && size > 20 * 1024 * 1024 && Platform.isMobile) {
			new Notice('This Kobo database is larger than 20 MB, so the import may take a while on a phone.', 6000);
		}
		const bookmarks = result.highlights.filter((h) => h.kind === 'bookmark').length;
		const usable = this.settings.skipBookmarks ? result.highlights.length - bookmarks : result.highlights.length;
		if (!usable) {
			if (result.issues.length) console.warn('Passagewise: nothing imported', result.issues);
			new Notice(emptyResultMessage({
				name, formatLabel: formatLabel(format), bookmarks, skipBookmarks: this.settings.skipBookmarks,
				damaged: result.damaged, reason: result.issues[0]?.message, warnings: result.warnings,
			}), 10000);
			return;
		}

		const deduped = dedupeHighlights(result.highlights);
		const report = await syncHighlights(deduped.highlights, new VaultBridge(this.app), {
			folder: this.settings.folder,
			fileNameTemplate: this.settings.fileNameTemplate,
			skipBookmarks: this.settings.skipBookmarks,
			index: this.settings.index,
		});
		this.settings.index = report.index;
		await this.saveSettings();
		if (result.issues.length) console.warn(`Passagewise: ${result.issues.length} entr${result.issues.length === 1 ? 'y' : 'ies'} could not be read`, result.issues);
		new Notice(importSummary({
			name,
			added: report.newHighlights,
			books: report.booksWritten,
			created: report.createdNotes,
			updated: report.updatedNotes,
			already: report.alreadyInNotes,
			duplicates: deduped.skipped,
			bookmarks: report.skippedBookmarks,
			unreadable: result.issues.length,
			warnings: result.warnings,
		}), 10000);
		if (this.settings.openAfter && report.changedPaths[0]) {
			const first = this.app.vault.getAbstractFileByPath(normalizePath(report.changedPaths[0]));
			// An updated note opens at the first new highlight (it is usually at the end), a new note at the top.
			const line = report.firstNewLine[report.changedPaths[0]];
			if (first instanceof TFile) await this.app.workspace.getLeaf(false).openFile(first, line != null ? { eState: { line } } : undefined);
		}
	}

	async loadSettings() {
		const raw = ((await this.loadData()) ?? {}) as Partial<Settings> & { pro?: unknown };
		delete raw.pro; // prototype field, never trusted
		this.settings = { ...DEFAULTS, ...raw, license: { ...EMPTY_LICENSE, ...(raw.license ?? {}) }, index: raw.index || {} };
		this.keyStore = selectKeyStore(this.app);
		this.settings.license.key = this.keyStore.load(this.settings.license.key);
	}

	async saveSettings() {
		await this.saveData({ ...this.settings, license: { ...this.settings.license, key: this.keyStore.keyForDataJson(this.settings.license.key) } });
	}
}

/** One settings row. The same rows feed getSettingDefinitions() (Obsidian 1.13+) and display() (older). */
interface Row { name: string; desc?: string; visible?: () => boolean; build?: (st: Setting) => unknown }
interface Section { heading?: string; rows: Row[] }

class PassagewiseSettingTab extends PluginSettingTab {
	private buyGate: BuyGate | null = null;
	private consent: ConsentState | null = null;
	private keyDraft = '';
	constructor(app: App, private plugin: PassagewisePlugin) { super(app, plugin); }

	hide(): void { this.buyGate = null; this.consent = null; }

	private refresh(): void {
		if (requireApiVersion('1.13.0')) this.update();
		else this.renderLegacy();
	}

	private proRows(): Row[] {
		const lic = this.plugin.license;
		const pro = lic.isPro();
		const rows: Row[] = [];
		const status = pro ? `Pro is active. Works offline for ${lic.graceDaysLeft()} more day${lic.graceDaysLeft() === 1 ? '' : 's'}.`
			: lic.state.status === 'invalid' ? 'Pro is locked: this key isn\'t active.' : 'You\'re on the free version. Kindle imports are free.';
		rows.push({ name: 'Status', desc: lic.state.message ? `${status} ${lic.state.message}` : status,
			// No region request at all while checkout is not ready.
			build: () => {
				if (!CHECKOUT_READY || pro) return;
				const gate = this.buyGate ?? (this.buyGate = new BuyGate(obsidianHttpGetJson));
				void gate.ensure(() => this.refresh());
			} });

		const gateState = () => this.buyGate?.current ?? 'unknown';
		const buyRows: Row[] = [
			{ name: 'Passagewise Pro', desc: 'Adds Kobo and KOReader imports. US$12 once. Not on sale yet.', visible: () => !pro && !CHECKOUT_READY },
			{ name: 'Checking region…', visible: () => CHECKOUT_READY && !pro && gateState() === 'unknown' },
			{ name: 'Passagewise Pro', desc: 'Couldn\'t check your region. Reopen settings later to try again.', visible: () => CHECKOUT_READY && !pro && gateState() === 'error' },
			{ name: 'Get Passagewise Pro', desc: 'Kobo and KOReader imports. US$12 once (plus tax), all future updates, 5 devices, 14-day refund; not sold in Japan.',
				visible: () => CHECKOUT_READY && !pro && gateState() === 'show',
				build: (st) => {
					st.infoEl.querySelectorAll('.pw-consent-block').forEach((e) => e.remove());
					const consent = this.consent = new ConsentState();
					const { block } = buildConsentBlock(st.infoEl, consent, () => openCheckoutIfConsented(consent, CHECKOUT_URL, (u) => {
						if (!CHECKOUT_READY) { new Notice('Passagewise Pro is not on sale yet.'); return; }
						window.open(u);
					}), (u) => { window.open(u); });
					return () => block.remove();
				} },
		];
		const keyFirst = !!lic.state.key;
		if (!keyFirst) rows.push(...buyRows);
		rows.push({ name: 'This device', visible: () => !!lic.state.key, desc: `Device code ${this.plugin.deviceCode}. In the Polar customer portal this device is listed as "${this.plugin.deviceLabel}".` });
		this.keyDraft = lic.state.key;
		rows.push({ name: 'License key',
			desc: (this.plugin.keyStore.kind === 'keychain' ? 'Kept in Obsidian Keychain, not in your vault. '
				: 'Your Obsidian version has no Keychain, so the key is kept in plain text in this plugin\'s data.json. Update Obsidian to 1.11.4 or later to keep it in Keychain. ')
				+ 'Sent only to Polar (api.polar.sh) when you press Activate, then at most once a day.',
			build: (st) => st
				.addText((t) => { t.inputEl.type = 'password'; t.setPlaceholder('License key').setValue(this.keyDraft).onChange((v) => { this.keyDraft = v.trim(); }); })
				.addButton((b) => b.setButtonText('Activate').setCta().onClick(async () => {
					if (!this.keyDraft) { new Notice('Paste your license key first.'); return; }
					b.setDisabled(true);
					await lic.activate(this.keyDraft, this.plugin.deviceLabel);
					this.refresh();
				}))
				.addButton((b) => b.setButtonText('Remove').onClick(async () => { await lic.clear(); this.refresh(); })) });
		if (keyFirst) rows.push(...buyRows);
		return rows;
	}

	private sections(): Section[] {
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		const general: Row[] = [
			{ name: 'Import highlights', desc: 'Choose a My Clippings.txt or another export. It can be on this device or already in your vault.',
				build: (st) => st.addButton((b) => b.setButtonText('Import…').onClick(() => this.plugin.openPicker())) },
			{ name: 'Highlights folder', desc: 'Book notes are created here. Leave empty to use the vault root.',
				build: (st) => st.addText((t) => t.setPlaceholder('Highlights').setValue(s.folder).onChange(async (v) => { s.folder = v.trim(); await save(); })) },
			{ name: 'Note name', desc: 'Use {{title}} and {{authors}}. Characters that are not allowed in file names are removed. Existing notes keep their names.',
				build: (st) => st.addText((t) => t.setPlaceholder('{{title}}').setValue(s.fileNameTemplate).onChange(async (v) => { s.fileNameTemplate = v.trim() || '{{title}}'; await save(); })) },
			{ name: 'Skip bookmarks', desc: 'Bookmarks have no text, so they are skipped unless you turn this off.',
				build: (st) => st.addToggle((t) => t.setValue(s.skipBookmarks).onChange(async (v) => { s.skipBookmarks = v; await save(); })) },
			{ name: 'Open the note after import',
				build: (st) => st.addToggle((t) => t.setValue(s.openAfter).onChange(async (v) => { s.openAfter = v; await save(); })) },
		];
		return [{ rows: general }, { heading: 'Pro', rows: this.proRows() }];
	}

	private static fill(st: Setting, r: Row): void | (() => void) {
		st.setName(r.name);
		if (r.desc) st.setDesc(r.desc);
		const cleanup = r.build?.(st);
		return typeof cleanup === 'function' ? cleanup as () => void : undefined;
	}

	/** Obsidian 1.13+: declarative settings, also indexed by the settings search. */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return this.sections().map((sec): SettingDefinitionGroup => ({
			type: 'group',
			heading: sec.heading,
			items: sec.rows.map((r) => ({ name: r.name, desc: r.desc, visible: r.visible, render: (st: Setting) => PassagewiseSettingTab.fill(st, r) })),
		}));
	}

	/** Obsidian 1.5–1.12 only (minAppVersion 1.5.0). 1.13+ renders getSettingDefinitions() and never calls this. */
	display(): void { this.renderLegacy(); }

	private renderLegacy(): void {
		const { containerEl: el } = this;
		el.empty();
		el.addClass('passagewise-settings');
		for (const sec of this.sections()) {
			if (sec.heading) new Setting(el).setName(sec.heading).setHeading();
			for (const r of sec.rows) if (!r.visible || r.visible()) PassagewiseSettingTab.fill(new Setting(el), r);
		}
	}
}

export type { Highlight };
