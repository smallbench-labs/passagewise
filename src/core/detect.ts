import { HighlightSource, ParseResult } from './model';
import { looksLikeClippings, parseKindleClippings } from './parseClippings';
import { looksLikeKindleHtml, parseKindleHtml } from './parseKindleHtml';
import { looksLikeKoreaderJson, looksLikeKoreaderLua, parseKoreaderJson, parseKoreaderLua } from './parseKoreader';
import { looksLikeKoboSqlite, parseKoboSqlite } from './parseKobo';
import { isSqliteHeader } from './sqlite';

export type DetectedFormat = HighlightSource | 'unknown';

export function detectFormat(raw: string, fileName?: string): DetectedFormat {
	if (fileName && /\.(sqlite|sqlite3|db)$/i.test(fileName)) return 'kobo-sqlite';
	if (looksLikeKindleHtml(raw, fileName)) return 'kindle-html';
	if (looksLikeKoreaderLua(raw, fileName)) return 'koreader-lua';
	if (looksLikeKoreaderJson(raw, fileName)) return 'koreader-json';
	if (looksLikeClippings(raw, fileName)) return 'kindle-clippings';
	if (fileName && /\.html?$/i.test(fileName)) return 'kindle-html';
	if (fileName && /\.lua$/i.test(fileName) && /\["(annotations|highlight|bookmarks|doc_props)"\]/.test(raw)) return 'koreader-lua';
	if (fileName && /\.json$/i.test(fileName) && !isOtherJson(raw)) return 'koreader-json';
	if (fileName && /\.txt$/i.test(fileName) && raw.includes('==========')) return 'kindle-clippings';
	return 'unknown';
}

/** Valid JSON that is not a KOReader export (a random .json in the vault). Broken JSON stays "KOReader" so the user hears it is damaged. */
function isOtherJson(raw: string): boolean {
	try {
		const data = JSON.parse(raw) as unknown;
		if (!data || typeof data !== 'object' || Array.isArray(data)) return true;
		const root = data as Record<string, unknown>;
		return !Array.isArray(root.entries) && !Array.isArray(root.documents) && !Array.isArray(root.highlights);
	} catch {
		return false;
	}
}

export function detectBinaryFormat(data: ArrayBuffer | Uint8Array, fileName?: string): DetectedFormat {
	if (isSqliteHeader(data) || looksLikeKoboSqlite(data, fileName)) return 'kobo-sqlite';
	return 'unknown';
}

export function parseImport(raw: string, fileName?: string): { format: DetectedFormat; result: ParseResult } {
	const format = detectFormat(raw, fileName);
	if (format === 'kindle-html') return { format, result: parseKindleHtml(raw) };
	if (format === 'koreader-lua') return { format, result: parseKoreaderLua(raw) };
	if (format === 'koreader-json') return { format, result: parseKoreaderJson(raw) };
	if (format === 'kindle-clippings') return { format, result: parseKindleClippings(raw) };
	if (format === 'kobo-sqlite') {
		return { format, result: { highlights: [], issues: [{ message: 'This Kobo database must be read as a binary file' }] } };
	}
	return { format, result: { highlights: [], issues: [{ message: 'This file does not look like a supported export' }] } };
}

export function parseBinaryImport(data: ArrayBuffer | Uint8Array, fileName?: string): { format: DetectedFormat; result: ParseResult } {
	const format = detectBinaryFormat(data, fileName);
	if (format === 'kobo-sqlite') return { format, result: parseKoboSqlite(data) };
	return { format, result: { highlights: [], issues: [{ message: 'This file does not look like a supported export' }] } };
}

export function isProFormat(format: DetectedFormat): boolean {
	return format === 'koreader-lua' || format === 'koreader-json' || format === 'kobo-sqlite';
}
