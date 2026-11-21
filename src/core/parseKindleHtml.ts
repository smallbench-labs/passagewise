import { Highlight, HighlightKind, ParseResult } from './model';
import { bookKey, highlightId, normalizeNewlines, stripTags } from './text';

interface HtmlBlock {
	cls: string;
	text: string;
	html: string;
}

function extractBlocks(html: string): HtmlBlock[] {
	const normalized = normalizeNewlines(html)
		.replace(/<\/?h[1-6]/gi, (tag) => (tag.startsWith('</') ? '</div' : '<div'));
	const blocks: HtmlBlock[] = [];
	const opener = /<div\b([^>]*)>/gi;
	let match: RegExpExecArray | null;
	while ((match = opener.exec(normalized))) {
		const attrs = match[1] || '';
		const classMatch = /class\s*=\s*["']([^"']+)["']/i.exec(attrs);
		if (!classMatch) continue;
		const classes = classMatch[1].split(/\s+/);
		const cls = ['bookTitle', 'authors', 'citation', 'sectionHeading', 'noteHeading', 'noteText']
			.find((name) => classes.includes(name));
		if (!cls) continue;
		const start = match.index + match[0].length;
		const rest = normalized.slice(start);
		const end = rest.search(/<\/div>|<div\b/i);
		const inner = end === -1 ? rest : rest.slice(0, end);
		blocks.push({ cls, html: inner, text: stripTags(inner) });
	}
	return blocks;
}

function parseHeading(text: string): { kind: HighlightKind; page?: number; location?: string; chapter: string; color: string } | null {
	const kindMatch = /^(Highlight|Note|Bookmark|ハイライト|メモ|标注|標註|筆記|笔记|Surlignement|Markierung|Notiz|Subrayado|Nota|Evidenziazione|Destaque)\b/i.exec(text);
	if (!kindMatch) return null;
	const label = kindMatch[1].toLowerCase();
	let kind: HighlightKind = 'highlight';
	if (/^(note|メモ|筆記|笔记|notiz|nota)$/i.test(label)) kind = 'note';
	else if (/^bookmark/i.test(label)) kind = 'bookmark';

	const colorMatch = /\(\s*([^)]+?)\s*\)/.exec(text);
	const color = (colorMatch?.[1] || '').replace(/\s+/g, ' ').trim();
	const locationMatch = /(?:Location|Loc\.?|位置)\s*#?\s*(\d+(?:\s*[-–—]\s*\d+)?)/i.exec(text);
	const pageMatch = /Page\s+(\d+)/i.exec(text) || /第\s*(\d+)\s*(?:页|頁)/.exec(text);
	const afterDash = text.split(/\s-\s/).slice(1).join(' - ').trim();
	let chapter = '';
	if (afterDash.includes('>')) chapter = afterDash.split('>')[0].trim();
	else if (afterDash && !/^Page\b/i.test(afterDash) && !/^(Location|Loc\.?)\b/i.test(afterDash)) {
		chapter = afterDash.replace(/\s*[·•]\s*Page.*$/i, '').replace(/\s+(Location|Loc\.?).*$/i, '').trim();
	}
	return {
		kind,
		page: pageMatch ? Number(pageMatch[1]) : undefined,
		location: locationMatch?.[1].replace(/\s+/g, ''),
		chapter,
		color,
	};
}

function locationRange(raw?: string): { start?: number; end?: number; raw?: string } {
	if (!raw) return {};
	const match = /(\d+)(?:[-–—](\d+))?/.exec(raw);
	if (!match) return { raw };
	const start = Number(match[1]);
	return { start, end: match[2] ? Number(match[2]) : start, raw };
}

export function parseKindleHtml(raw: string): ParseResult {
	const blocks = extractBlocks(raw);
	if (!blocks.length) return { highlights: [], issues: [{ message: 'No notebook headings were found in this HTML file' }] };

	const title = blocks.find((b) => b.cls === 'bookTitle')?.text || 'Untitled';
	const authors = blocks.find((b) => b.cls === 'authors')?.text || '';
	const key = bookKey(title, authors);
	const highlights: Highlight[] = [];
	const issues: ParseResult['issues'] = [];
	let chapter = '';

	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		if (block.cls === 'sectionHeading') {
			chapter = block.text;
			continue;
		}
		if (block.cls !== 'noteHeading') continue;
		const heading = parseHeading(block.text);
		if (!heading) {
			issues.push({ message: `Unrecognised heading: ${block.text}` });
			continue;
		}
		const next = blocks[i + 1];
		if (!next || next.cls !== 'noteText') {
			if (heading.kind !== 'bookmark') issues.push({ message: `Heading has no text: ${block.text}` });
			continue;
		}
		i += 1;
		const body = next.text;
		if (heading.kind === 'bookmark') continue;

		if (heading.kind === 'note') {
			const previous = [...highlights].reverse().find((h) => {
				if (h.bookKey !== key || h.kind !== 'highlight') return false;
				if (heading.location && h.location.raw) {
					return locationRange(heading.location).start === h.location.start;
				}
				return heading.page != null && h.page === heading.page;
			});
			if (previous && !previous.note) {
				previous.note = body;
				continue;
			}
		}

		const text = heading.kind === 'note' ? '' : body;
		const note = heading.kind === 'note' ? body : '';
		const loc = locationRange(heading.location);
		highlights.push({
			id: highlightId(key, text || note, heading.kind),
			aliases: [],
			bookKey: key,
			title,
			authors,
			kind: heading.kind,
			text,
			note,
			location: loc,
			page: heading.page,
			chapter: heading.chapter || chapter,
			color: heading.color,
			addedAtRaw: '',
			source: 'kindle-html',
		});
	}

	return { highlights, issues };
}

export function looksLikeKindleHtml(raw: string, fileName?: string): boolean {
	if (fileName && /\.html?$/i.test(fileName) && /noteHeading|bookTitle/.test(raw)) return true;
	return /class=["'][^"']*bookTitle/.test(raw) && /class=["'][^"']*noteHeading/.test(raw);
}
