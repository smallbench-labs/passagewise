import { BookIndex, Highlight, SyncOptions, SyncReport, VaultLike } from './model';
import { normalizeText, sanitizeFileName } from './text';

/**
 * Note layout (one note per book):
 *
 *   ---
 *   title: "…"
 *   authors: "…"
 *   ---
 *
 *   ## Highlights
 *
 *   > quote
 *
 *   attached note from the reader
 *
 *   p. 3 · loc. 41–45 · 2016-03-26 ^pw-b402e2a9d5e45050
 *
 * Each highlight ends with an Obsidian block ID (`^pw-<id>`). Obsidian hides block IDs in
 * Reading view and shows them small in Live Preview, and they can be linked to (`[[Book#^pw-…]]`).
 * Re-import never rewrites existing text: it only inserts new highlights at the end of the
 * section that holds the last imported highlight. If a previously imported highlight was
 * deleted from the note and is still in the export file, the next import adds it again
 * (established behaviour, 2026-11-21). The plugin does not remember deletions.
 */

export const BLOCK_PREFIX = 'pw-';
const BLOCK_ID_RE = /\^pw-([a-f0-9]{8,32})\s*$/gm;
/** Prototype layout from 2026-11-19 (HTML comment per highlight). Still recognised so its notes are not duplicated. */
const LEGACY_ITEM_RE = /<!-- passagewise:item:([a-f0-9]+)(?: aliases:([^>]*))? -->/g;
const LEGACY_END_RE = /<!-- passagewise:(?:item:[a-f0-9]+:end|managed:end) -->/;

export function blockId(id: string): string {
	return `^${BLOCK_PREFIX}${id}`;
}

export function formatMeta(item: Highlight): string {
	const parts: string[] = [];
	if (item.page != null) parts.push(`p. ${item.page}`);
	if (item.location.start != null) {
		const end = item.location.end && item.location.end !== item.location.start ? `–${item.location.end}` : '';
		parts.push(`loc. ${item.location.start}${end}`);
	}
	if (item.chapter) parts.push(item.chapter);
	if (item.addedAt) parts.push(item.addedAt.slice(0, 10));
	else if (item.addedAtRaw) parts.push(item.addedAtRaw);
	return parts.join(' · ');
}

/** A reader note must not turn into a heading, list marker clash or code fence in the book note. */
function escapeNoteLine(line: string): string {
	if (/^\s{0,3}#{1,6}(\s|$)/.test(line)) return line.replace('#', '\\#');
	if (/^\s{0,3}(```|~~~)/.test(line)) return `\\${line.trimStart()}`;
	if (/^\s{0,3}---+\s*$/.test(line)) return line.replace('-', '\\-');
	return line;
}

export function renderItem(item: Highlight): string {
	const parts: string[] = [];
	if (item.text) parts.push(item.text.split('\n').map((l) => `> ${l}`).join('\n'));
	if (item.note) parts.push(item.note.split('\n').map(escapeNoteLine).join('\n'));
	const meta = formatMeta(item);
	if (meta) parts.push(meta);
	if (!parts.length) parts.push('(bookmark)');
	parts[parts.length - 1] += ` ${blockId(item.id)}`;
	return parts.join('\n\n');
}

/** IDs of highlights already in a note (block IDs, plus prototype comment markers and their aliases). */
export function knownIdsInNote(content: string): Set<string> {
	const ids = new Set<string>();
	for (const m of content.matchAll(BLOCK_ID_RE)) ids.add(m[1]);
	for (const m of content.matchAll(LEGACY_ITEM_RE)) {
		ids.add(m[1]);
		for (const alias of (m[2] || '').split(',')) if (alias.trim()) ids.add(alias.trim());
	}
	return ids;
}

export function idsOf(item: { id: string; aliases: string[] }): string[] {
	return [item.id, ...item.aliases];
}

/** Normalised text used to spot a highlight that is already quoted in the note under another ID. */
function comparable(value: string): string {
	return normalizeText(value).toLowerCase();
}

function stripQuoteMarkers(content: string): string {
	return content.replace(/^\s*>\s?/gm, '');
}

/**
 * Line index where new highlights go: the end of the section that contains the last imported highlight
 * (before the next heading of the same or higher level). -1 means "no highlights yet".
 */
export function insertionLine(lines: string[]): number {
	let last = -1;
	for (let i = 0; i < lines.length; i++) {
		if (/\^pw-[a-f0-9]{8,32}\s*$/.test(lines[i]) || LEGACY_END_RE.test(lines[i])) last = i;
	}
	if (last === -1) return -1;
	let level = 7;
	let inFence = false;
	for (let i = 0; i <= last; i++) {
		if (/^\s{0,3}(```|~~~)/.test(lines[i])) inFence = !inFence;
		const h = !inFence && /^(#{1,6})\s/.exec(lines[i]);
		if (h) level = h[1].length;
	}
	inFence = false;
	for (let i = last + 1; i < lines.length; i++) {
		if (/^\s{0,3}(```|~~~)/.test(lines[i])) inFence = !inFence;
		const h = !inFence && /^(#{1,6})\s/.exec(lines[i]);
		if (h && h[1].length <= level) {
			let end = i;
			while (end > last + 1 && !lines[end - 1].trim()) end -= 1;
			return end;
		}
	}
	let end = lines.length;
	while (end > last + 1 && !lines[end - 1].trim()) end -= 1;
	return end;
}

/** Index of the line after an existing "## Highlights" heading section, or -1. */
function highlightsHeadingEnd(lines: string[]): number {
	const start = lines.findIndex((l) => /^#{1,6}\s+Highlights\s*$/i.test(l));
	if (start === -1) return -1;
	const level = (/^(#+)/.exec(lines[start]) as RegExpExecArray)[1].length;
	for (let i = start + 1; i < lines.length; i++) {
		const h = /^(#{1,6})\s/.exec(lines[i]);
		if (h && h[1].length <= level) {
			let end = i;
			while (end > start + 1 && !lines[end - 1].trim()) end -= 1;
			return end;
		}
	}
	let end = lines.length;
	while (end > start + 1 && !lines[end - 1].trim()) end -= 1;
	return end;
}

export function defaultNoteBody(title: string, authors: string, items: string): string {
	// No empty `authors` property: Obsidian would show an empty row (e.g. sideloaded Kobo books without metadata).
	const authorLine = authors.trim() ? `authors: ${yamlQuote(authors)}\n` : '';
	return `---\ntitle: ${yamlQuote(title)}\n${authorLine}---\n\n## Highlights\n\n${items}\n`;
}

function yamlQuote(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface Applied {
	content: string;
	added: number;
	kept: number;
	created: boolean;
	changed: boolean;
	/** 0-based line of the first added highlight in `content` (set when something was added to an existing note). */
	firstNewLine?: number;
}

/** Pick the incoming highlights that are not in the note yet (by ID, alias, or quote text already present). */
export function newItemsFor(existing: string | null, incoming: Highlight[]): { fresh: Highlight[]; kept: number } {
	if (!existing) return { fresh: dedupeById(incoming), kept: 0 };
	const known = knownIdsInNote(existing);
	const kept = known.size;
	let haystack: string | null = null;
	const fresh: Highlight[] = [];
	for (const item of incoming) {
		if (idsOf(item).some((id) => known.has(id))) continue;
		const quote = comparable(item.text || item.note);
		if (quote.length >= 16) {
			haystack ??= comparable(stripQuoteMarkers(existing));
			if (haystack.includes(quote)) continue;
		}
		fresh.push(item);
		for (const id of idsOf(item)) known.add(id);
	}
	return { fresh, kept };
}

function dedupeById(items: Highlight[]): Highlight[] {
	const seen = new Set<string>();
	const out: Highlight[] = [];
	for (const item of items) {
		if (idsOf(item).some((id) => seen.has(id))) continue;
		for (const id of idsOf(item)) seen.add(id);
		out.push(item);
	}
	return out;
}

export function applyRegion(existing: string | null, title: string, authors: string, incoming: Highlight[]): Applied {
	const { fresh, kept } = newItemsFor(existing, incoming);
	const rendered = fresh.map(renderItem).join('\n\n');
	if (!existing) {
		return { content: defaultNoteBody(title, authors, rendered), added: fresh.length, kept: 0, created: true, changed: true };
	}
	if (!fresh.length) return { content: existing, added: 0, kept, created: false, changed: false };

	const eol = existing.includes('\r\n') ? '\r\n' : '\n';
	const lines = existing.split(/\r?\n/);
	let at = insertionLine(lines);
	if (at === -1) at = highlightsHeadingEnd(lines);
	let content: string;
	let firstNewLine: number;
	if (at === -1) {
		const body = existing.replace(/\s+$/, '');
		content = `${body}${body ? '\n\n' : ''}## Highlights\n\n${rendered}\n`;
		firstNewLine = content.split('\n').length - 1 - rendered.split('\n').length;
	} else {
		const before = lines.slice(0, at);
		const after = lines.slice(at);
		while (before.length && !before[before.length - 1].trim()) before.pop();
		while (after.length && !after[0].trim()) after.shift();
		const tail = after.length && after.some((l) => l.trim()) ? ['', ...after] : [''];
		content = [...before, '', ...rendered.split('\n'), ...tail].join('\n');
		firstNewLine = before.length + 1;
	}
	if (eol === '\r\n') content = content.replace(/\r?\n/g, '\r\n');
	return { content, added: fresh.length, kept, created: false, changed: true, firstNewLine };
}

export function notePath(folder: string, title: string, authors: string, template: string): string {
	const name = sanitizeFileName(
		template.replace(/\{\{\s*title\s*\}\}/g, title).replace(/\{\{\s*authors\s*\}\}/g, authors).trim() || title,
	);
	const dir = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
	return dir ? `${dir}/${name}.md` : `${name}.md`;
}

export async function syncHighlights(
	highlights: Highlight[],
	vault: VaultLike,
	options: SyncOptions,
): Promise<SyncReport> {
	const usable = options.skipBookmarks ? highlights.filter((h) => h.kind !== 'bookmark') : highlights.slice();
	const skippedBookmarks = highlights.length - usable.length;
	const byBook = new Map<string, Highlight[]>();
	for (const item of usable) {
		const list = byBook.get(item.bookKey) || [];
		list.push(item);
		byBook.set(item.bookKey, list);
	}

	const index: BookIndex = { ...options.index };
	const paths: string[] = [];
	const changedPaths: string[] = [];
	const firstNewLine: Record<string, number> = {};
	let createdNotes = 0;
	let updatedNotes = 0;
	let unchangedNotes = 0;
	let newHighlights = 0;
	let alreadyInNotes = 0;
	if (options.folder && vault.createFolder && byBook.size) {
		try { await vault.createFolder(options.folder); } catch { /* folder may already exist */ }
	}

	for (const [key, items] of byBook) {
		const title = items[0].title;
		const authors = items[0].authors;
		const indexed = index[key]?.path;
		const path = indexed && (await vault.exists(indexed)) ? indexed : notePath(options.folder, title, authors, options.fileNameTemplate);
		const existing = (await vault.exists(path)) ? await vault.read(path) : null;
		const applied = applyRegion(existing, title, authors, items);
		if (applied.changed) {
			await vault.write(path, applied.content);
			changedPaths.push(path);
			if (applied.firstNewLine != null) firstNewLine[path] = applied.firstNewLine;
		}
		index[key] = { path };
		paths.push(path);
		if (applied.created) createdNotes += 1;
		else if (applied.changed) updatedNotes += 1;
		else unchangedNotes += 1;
		newHighlights += applied.added;
		alreadyInNotes += items.length - applied.added;
	}

	return {
		booksWritten: byBook.size,
		createdNotes,
		updatedNotes,
		unchangedNotes,
		newHighlights,
		keptHighlights: alreadyInNotes,
		alreadyInNotes,
		skippedBookmarks,
		skippedDuplicates: 0,
		paths,
		changedPaths,
		firstNewLine,
		index,
	};
}
