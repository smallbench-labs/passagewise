import { Highlight, HighlightKind, ParseResult } from './model';
import { parseAddedDate, stripDatePrefix } from './dates';
import { bookKey, highlightId, normalizeNewlines, normalizeText, parseTitleAuthor } from './text';

const KIND_RULES: Array<{ kind: HighlightKind; pattern: RegExp }> = [
	{ kind: 'highlight', pattern: /highlight|surlignement|markierung|subrayado|evidenziazione|destaque|wyróżnienie|zvýraznění|выделенн|ハイライト|标注|標註|螢光標示/i },
	{ kind: 'bookmark', pattern: /bookmark|lesezeichen|marcador|signet|segnalibro|zakładk|záložk|закладк|ブックマーク|书签|書籤/i },
	{ kind: 'note', pattern: /note|notiz|\bnota\b|メモ|筆記|笔记|заметк|notatk|poznámk/i },
];

const LOCATION_RE = /(?:location|loc\.?|posizione|posición|posição|position|emplacement|pozycja|pozice|位置\s*No\.?|位置\s*#|位置#|位置)\s*#?\s*(\d+)(?:\s*[-–—]\s*(\d+))?/i;
const PAGE_RE = /(?:on page|at page|page|página|pagina|seite|strona|stránka)\s*(\d+)/i;
const PAGE_CJK_RE = /第\s*(\d+)\s*(?:页|頁)|ページ\s*(\d+)|(\d+)\s*ページ/;

/** A Kindle metadata line names the kind (highlight, note, bookmark) or a page/location, usually with "|" separators. */
function looksLikeMetaLine(meta: string): boolean {
	return KIND_RULES.some((rule) => rule.pattern.test(meta)) || LOCATION_RE.test(meta) || PAGE_RE.test(meta) || PAGE_CJK_RE.test(meta);
}

function parseKind(meta: string): HighlightKind {
	for (const rule of KIND_RULES) {
		if (rule.pattern.test(meta)) return rule.kind;
	}
	return 'highlight';
}

function parsePage(meta: string): number | undefined {
	const west = PAGE_RE.exec(meta);
	if (west) return Number(west[1]);
	const cjk = PAGE_CJK_RE.exec(meta);
	if (cjk) return Number(cjk[1] || cjk[2] || cjk[3]);
	return undefined;
}

function parseLocation(meta: string): { start?: number; end?: number; raw?: string } {
	const match = LOCATION_RE.exec(meta);
	if (!match) return {};
	const start = Number(match[1]);
	const end = match[2] ? Number(match[2]) : start;
	return { start, end, raw: match[0] };
}

function parseOne(block: string): Highlight | { error: string; block: string } | null {
	const lines = block.split('\n').map((line) => line.replace(/\s+$/, ''));
	while (lines.length && !lines[0].trim()) lines.shift();
	if (!lines.length) return null;
	if (lines[0] === '==========') lines.shift();
	while (lines.length && !lines[0].trim()) lines.shift();
	if (lines.length < 2) return lines.some((l) => l.trim()) ? { error: 'Entry is missing a metadata line', block } : null;

	const titleLine = lines[0].trim();
	const metaLine = lines[1].trim().replace(/^[—–-]\s*/, '');
	let bodyStart = 2;
	while (bodyStart < lines.length && !lines[bodyStart].trim()) bodyStart += 1;
	const text = lines.slice(bodyStart).join('\n').trim();

	if (!titleLine) return { error: 'Entry is missing a title', block };
	if (!looksLikeMetaLine(metaLine)) return { error: 'Entry does not look like a Kindle clipping', block };

	const { title, authors } = parseTitleAuthor(titleLine);
	const kind = parseKind(metaLine);
	const location = parseLocation(metaLine);
	const page = parsePage(metaLine);
	const parts = metaLine.split('|').map((part) => part.trim());
	const addedAtRaw = parts.length ? stripDatePrefix(parts[parts.length - 1]) : '';
	const addedAt = addedAtRaw ? parseAddedDate(addedAtRaw) : undefined;
	const key = bookKey(title, authors);
	const body = kind === 'note' ? '' : text;
	const note = kind === 'note' ? text : '';
	if (kind !== 'bookmark' && !normalizeText(text)) {
		return { error: 'Entry has no text', block };
	}

	const contentForId = kind === 'note' ? note : body;
	return {
		id: highlightId(key, contentForId || `loc:${location.start ?? ''}:${page ?? ''}`, kind),
		aliases: [],
		bookKey: key,
		title,
		authors,
		kind,
		text: body,
		note,
		location,
		page,
		chapter: '',
		color: '',
		addedAt,
		addedAtRaw,
		source: 'kindle-clippings',
	};
}

/** Attach a standalone clipping note to a highlight at the same book and location when possible. */
export function attachClippingNotes(items: Highlight[]): Highlight[] {
	const result: Highlight[] = [];
	for (const item of items) {
		if (item.kind !== 'note') {
			result.push(item);
			continue;
		}
		const match = [...result].reverse().find((other) => {
			if (other.bookKey !== item.bookKey) return false;
			if (other.kind !== 'highlight') return false;
			if (item.location.start && other.location.start) return rangesOverlap(item.location, other.location);
			if (item.page && other.page) return item.page === other.page;
			return false;
		});
		if (match && !match.note) {
			match.note = item.note;
			if (item.addedAt && !match.addedAt) match.addedAt = item.addedAt;
		} else {
			result.push(item);
		}
	}
	return result;
}

export function rangesOverlap(a: { start?: number; end?: number }, b: { start?: number; end?: number }): boolean {
	if (a.start == null || b.start == null) return false;
	const aEnd = a.end ?? a.start;
	const bEnd = b.end ?? b.start;
	return a.start <= bEnd && b.start <= aEnd;
}

export function parseKindleClippings(raw: string): ParseResult {
	const text = normalizeNewlines(raw).trim();
	if (!text) return { highlights: [], issues: [{ message: 'The file is empty' }] };
	const chunks = text.split(/\n==========\s*(?:\n|$)/);
	const highlights: Highlight[] = [];
	const issues: ParseResult['issues'] = [];
	for (const chunk of chunks) {
		const parsed = parseOne(chunk);
		if (!parsed) continue;
		if ('error' in parsed) issues.push({ message: parsed.error, block: parsed.block.slice(0, 240) });
		else highlights.push(parsed);
	}
	return { highlights: attachClippingNotes(highlights), issues };
}

export function looksLikeClippings(raw: string, fileName?: string): boolean {
	if (fileName && /clippings/i.test(fileName)) return true;
	const text = normalizeNewlines(raw);
	return /==========/.test(text) && /^\s*-?\s*.+$/m.test(text);
}
