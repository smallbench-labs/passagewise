import { Highlight, ParseResult } from './model';
import { parseAddedDate } from './dates';
import { asNumber, asString, asTable, parseLuaValue, tableValues, LuaTable } from './parseLua';
import { bookKey, highlightId, normalizeNewlines } from './text';

function str(value: unknown, fallback = ''): string {
	return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : fallback;
}

function fromEntry(bookTitle: string, authors: string, source: Highlight['source'], entry: {
	text?: string;
	note?: string;
	page?: number;
	chapter?: string;
	color?: string;
	addedAtRaw?: string;
	pos0?: string;
	pos1?: string;
	kind?: Highlight['kind'];
}): Highlight | null {
	const text = (entry.text || '').trim();
	const note = (entry.note || '').trim();
	if (!text && !note) return null;
	const key = bookKey(bookTitle, authors);
	const kind = entry.kind || (text ? 'highlight' : 'note');
	return {
		id: highlightId(key, text || note, kind),
		aliases: [],
		bookKey: key,
		title: bookTitle,
		authors,
		kind,
		text: kind === 'note' ? '' : text,
		note: kind === 'note' ? (note || text) : note,
		location: entry.pos0 ? { raw: `${entry.pos0}..${entry.pos1 || entry.pos0}` } : {},
		page: entry.page,
		chapter: entry.chapter || '',
		color: entry.color || '',
		addedAt: entry.addedAtRaw ? parseAddedDate(entry.addedAtRaw) : undefined,
		addedAtRaw: entry.addedAtRaw || '',
		source,
	};
}

function pageOf(table: LuaTable): number | undefined {
	return asNumber(table.pageno) ?? asNumber(table.page) ?? undefined;
}

function annotationsFromLua(root: LuaTable): Highlight[] {
	const props = asTable(root.doc_props) || asTable(root.stats) || {};
	const title = asString(props.title) || asString(root.title) || 'Untitled';
	const authors = asString(props.authors) || asString(props.author) || asString(root.author) || '';
	const out: Highlight[] = [];

	const annotations = tableValues(asTable(root.annotations));
	for (const item of annotations) {
		const built = fromEntry(title, authors, 'koreader-lua', {
			text: asString(item.text),
			note: asString(item.note) || asString(item.comments),
			page: pageOf(item),
			chapter: asString(item.chapter),
			color: asString(item.color) || asString(item.drawer),
			addedAtRaw: asString(item.datetime) || asString(item.time),
			pos0: asString(item.pos0),
			pos1: asString(item.pos1),
		});
		if (built) out.push(built);
	}

	if (out.length) return out;

	// Older sidecars: highlights nested by page, plus bookmarks.
	const highlightRoot = asTable(root.highlight);
	if (highlightRoot) {
		for (const [pageKey, group] of Object.entries(highlightRoot)) {
			const page = Number(pageKey);
			for (const item of tableValues(asTable(group))) {
				const built = fromEntry(title, authors, 'koreader-lua', {
					text: asString(item.text) || asString(item.notes),
					note: asString(item.note) || asString(item.comments),
					page: asNumber(item.pageno) ?? (Number.isFinite(page) ? page : undefined),
					chapter: asString(item.chapter),
					color: asString(item.color) || asString(item.drawer),
					addedAtRaw: asString(item.datetime),
					pos0: asString(item.pos0),
					pos1: asString(item.pos1),
				});
				if (built) out.push(built);
			}
		}
	}

	for (const item of tableValues(asTable(root.bookmarks))) {
		const highlighted = item.highlighted === true || asString(item.highlighted) === 'true';
		const text = asString(item.notes) || asString(item.text);
		if (!highlighted && !text) continue;
		const built = fromEntry(title, authors, 'koreader-lua', {
			text,
			note: asString(item.note) || asString(item.comments),
			page: pageOf(item),
			chapter: asString(item.chapter),
			color: asString(item.color),
			addedAtRaw: asString(item.datetime),
		});
		if (built) out.push(built);
	}
	return out;
}

export function parseKoreaderLua(raw: string): ParseResult {
	try {
		const value = parseLuaValue(normalizeNewlines(raw));
		const table = asTable(value);
		if (!table) return { highlights: [], issues: [{ message: 'The Lua file did not contain a table' }] };
		return { highlights: annotationsFromLua(table), issues: [] };
	} catch (err) {
		return { highlights: [], damaged: true, issues: [{ message: err instanceof Error ? err.message : String(err) }] };
	}
}

function unixOrRaw(value: unknown): string {
	if (typeof value === 'number' && Number.isFinite(value)) {
		const d = new Date(value > 1e12 ? value : value * 1000);
		if (!Number.isNaN(d.getTime())) return d.toISOString();
	}
	return typeof value === 'string' ? value : '';
}

function entriesFromUnknown(book: Record<string, unknown>, source: Highlight['source']): Highlight[] {
	const title = str(book.title) || str(book.bookTitle) || 'Untitled';
	const authors = str(book.author) || str(book.authors);
	const entries = Array.isArray(book.entries) ? book.entries : Array.isArray(book.highlights) ? book.highlights : [];
	const out: Highlight[] = [];
	for (const raw of entries) {
		if (!raw || typeof raw !== 'object') continue;
		const entry = raw as Record<string, unknown>;
		const built = fromEntry(title, authors, source, {
			text: str(entry.text) || str(entry.highlight),
			note: str(entry.note) || str(entry.notes) || str(entry.comments),
			page: typeof entry.pageno === 'number' ? entry.pageno : typeof entry.page === 'number' ? entry.page : Number(entry.page) || undefined,
			chapter: str(entry.chapter),
			color: str(entry.color) || str(entry.drawer),
			addedAtRaw: unixOrRaw(entry.time ?? entry.datetime ?? entry.date),
			pos0: str(entry.pos0),
			pos1: str(entry.pos1),
			kind: entry.sort === 'note' || entry.kind === 'note' ? 'note' : 'highlight',
		});
		if (built) {
			if (typeof entry.page === 'string' && built.page == null && /^\d+$/.test(entry.page)) built.page = Number(entry.page);
			out.push(built);
		}
	}
	return out;
}

export function parseKoreaderJson(raw: string): ParseResult {
	try {
		const data = JSON.parse(raw) as unknown;
		if (!data || typeof data !== 'object') return { highlights: [], issues: [{ message: 'JSON root must be an object' }] };
		const root = data as Record<string, unknown>;
		const books = Array.isArray(root.documents) ? root.documents : [root];
		const highlights: Highlight[] = [];
		for (const book of books) {
			if (book && typeof book === 'object') highlights.push(...entriesFromUnknown(book as Record<string, unknown>, 'koreader-json'));
		}
		return { highlights, issues: [] };
	} catch (err) {
		return { highlights: [], damaged: true, issues: [{ message: err instanceof Error ? err.message : String(err) }] };
	}
}

export function looksLikeKoreaderLua(raw: string, fileName?: string): boolean {
	if (fileName && /metadata\..+\.lua$/i.test(fileName)) return true;
	return /^\s*--/.test(raw) && /\["annotations"\]|\["highlight"\]|\["bookmarks"\]|doc_props/.test(raw)
		|| /^\s*return\s*\{/.test(raw);
}

export function looksLikeKoreaderJson(raw: string, fileName?: string): boolean {
	const trimmed = raw.trim();
	if (!trimmed.startsWith('{')) return false;
	if (fileName && /\.json$/i.test(fileName) && /"entries"\s*:/.test(trimmed)) return true;
	return /"entries"\s*:/.test(trimmed) && /"title"\s*:/.test(trimmed);
}
