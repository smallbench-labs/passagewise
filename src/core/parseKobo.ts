import { Highlight, ParseResult } from './model';
import { parseAddedDate } from './dates';
import { bookKey, highlightId, sanitizeFileName } from './text';
import { column, findTable, isSqliteHeader, readSqlite, sqliteText, SqliteValue } from './sqlite';

function isHidden(value: SqliteValue | undefined): boolean {
	if (value === 1) return true;
	if (typeof value === 'string' && /^(true|1|yes)$/i.test(value.trim())) return true;
	return false;
}

function titleFromVolume(volumeId: string): string {
	const trimmed = volumeId.trim();
	if (!trimmed) return '';
	const withoutScheme = trimmed.replace(/^file:\/\//i, '');
	const base = withoutScheme.split('/').pop() || withoutScheme;
	return sanitizeFileName(decodeURIComponent(base).replace(/\.(epub|kepub|pdf|mobi|cbz|txt)$/i, '')).replace(/-/g, ' ').trim() || trimmed;
}

function truthyType(value: string): 'highlight' | 'note' | 'bookmark' | 'other' {
	const type = value.toLowerCase();
	if (type === 'highlight') return 'highlight';
	if (type === 'note') return 'note';
	if (type === 'dogear' || type === 'bookmark') return 'bookmark';
	return 'other';
}

export function looksLikeKoboSqlite(data: ArrayBuffer | Uint8Array, fileName?: string): boolean {
	if (fileName && /\.(sqlite|db|sqlite3)$/i.test(fileName)) return isSqliteHeader(data);
	return isSqliteHeader(data);
}

export function parseKoboSqlite(data: ArrayBuffer | Uint8Array): ParseResult {
	if (!isSqliteHeader(data)) {
		return { highlights: [], issues: [{ message: 'This file is not a SQLite database' }] };
	}
	let db;
	try {
		db = readSqlite(data);
	} catch (err) {
		return { highlights: [], damaged: true, issues: [{ message: err instanceof Error ? err.message : String(err) }] };
	}

	const issues: ParseResult['issues'] = [];
	const warnings: string[] = [];
	if (db.wal) {
		warnings.push('If your newest Kobo highlights are missing, eject the Kobo safely and copy KoboReader.sqlite again.');
	}
	if (db.encoding !== 'utf8') {
		warnings.push(`This database uses ${db.encoding} text, so some text may be misread.`);
	}
	if (!db.tables.length) {
		return { highlights: [], damaged: true, issues: [{ message: 'This SQLite file has no tables' }], warnings };
	}

	const bookmarks = findTable(db, 'Bookmark');
	if (!bookmarks) {
		return { highlights: [], issues: [...issues, { message: 'This database is not a Kobo KoboReader.sqlite (it has no Bookmark table)' }], warnings };
	}
	const contents = findTable(db, 'content') || findTable(db, 'Content');
	const contentById = new Map<string, Record<string, SqliteValue>>();
	if (contents) {
		for (const row of contents.rows) {
			const id = sqliteText(column(row, 'ContentID', 'ContentId', 'contentid'));
			if (id) contentById.set(id, row);
		}
	}

	const highlights: Highlight[] = [];
	let dogears = 0;
	for (const row of bookmarks.rows) {
		if (isHidden(column(row, 'Hidden'))) continue;
		const type = truthyType(sqliteText(column(row, 'Type')));
		if (type === 'bookmark') dogears += 1;
		if (type === 'bookmark' || type === 'other') continue;

		const text = sqliteText(column(row, 'Text')).trim();
		const note = sqliteText(column(row, 'Annotation')).trim();
		if (!text && !note) continue;

		const contentId = sqliteText(column(row, 'ContentID', 'ContentId'));
		const volumeId = sqliteText(column(row, 'VolumeID', 'VolumeId'));
		const content = (contentId && contentById.get(contentId)) || (volumeId && contentById.get(volumeId)) || undefined;
		let title = sqliteText(column(content || {}, 'BookTitle', 'BookTitle'));
		if (!title && content) title = sqliteText(column(content, 'Title'));
		if (!title) title = titleFromVolume(volumeId) || 'Untitled';
		const authors = sqliteText(column(content || {}, 'Attribution', 'Author', 'Authors'));
		let chapter = sqliteText(column(content || {}, 'Title', 'ChapterTitle'));
		if (chapter && chapter === title) chapter = '';

		const addedAtRaw = sqliteText(column(row, 'DateCreated', 'DateModified'));
		const startPath = sqliteText(column(row, 'StartContainerPath'));
		const bookmarkId = sqliteText(column(row, 'BookmarkID', 'BookmarkId'));
		const key = bookKey(title, authors);
		const kind = type === 'note' && !text ? 'note' : 'highlight';
		const body = kind === 'note' ? '' : (text || note);
		const attached = kind === 'note' ? (note || text) : note;
		const item: Highlight = {
			id: highlightId(key, body || attached, kind),
			aliases: bookmarkId ? [bookmarkId] : [],
			bookKey: key,
			title,
			authors,
			kind,
			text: body,
			note: attached && attached !== body ? attached : (kind === 'highlight' ? note : attached),
			location: startPath ? { raw: startPath } : {},
			chapter,
			color: sqliteText(column(row, 'Color')),
			addedAt: addedAtRaw ? parseAddedDate(addedAtRaw) : undefined,
			addedAtRaw,
			source: 'kobo-sqlite',
		};
		if (item.kind === 'highlight' && item.note && item.note === item.text) item.note = '';
		highlights.push(item);
	}

	if (!highlights.length && dogears) {
		warnings.unshift(`Only ${dogears.toLocaleString('en-US')} bookmark${dogears === 1 ? ' was' : 's were'} found. Kobo bookmarks have no text, so Passagewise imports highlights and notes only.`);
	}
	return warnings.length ? { highlights, issues, warnings } : { highlights, issues };
}
