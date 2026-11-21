/** Display and identity helpers. No Node APIs. */

export function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function normalizeNewlines(text: string): string {
	return stripBom(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function normalizeText(value: string): string {
	return value
		.normalize('NFC')
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010-\u2015\u2212]/g, '-')
		.replace(/\u00A0/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

export function normalizeKeyPart(value: string): string {
	return normalizeText(value)
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]+/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

export function bookKey(title: string, authors: string): string {
	const t = normalizeKeyPart(title) || 'untitled';
	const a = normalizeKeyPart(authors);
	return a ? `${t}|${a}` : t;
}

export function parseTitleAuthor(line: string): { title: string; authors: string } {
	const trimmed = normalizeText(line);
	const match = /^(.*)\s+\(([^()]+)\)\s*$/.exec(trimmed);
	if (!match) return { title: trimmed, authors: '' };
	return { title: match[1].trim(), authors: normalizeAuthors(match[2].trim()) };
}

export function normalizeAuthors(raw: string): string {
	let value = raw.trim();
	if (/^[^,]+,\s*[^,]+$/.test(value) && !/\s(and|&|;)\s/i.test(value)) {
		const [last, first] = value.split(',').map((part) => part.trim());
		if (last && first) value = `${first} ${last}`;
	}
	return value.replace(/\s+&\s+/g, '; ').replace(/\s+and\s+/g, '; ');
}

export function sanitizeFileName(title: string): string {
	const cleaned = normalizeText(title)
		.replace(/[\\/:*?"<>|]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 80);
	return cleaned || 'Untitled';
}

/** FNV-1a 64-bit, hex. Stable across desktop and mobile. */
export function fingerprint(value: string): string {
	let hi = 0x84222325;
	let lo = 0xcbf29ce4;
	for (let i = 0; i < value.length; i++) {
		lo ^= value.charCodeAt(i);
		const loMul = Math.imul(lo, 0x01000193);
		const hiMul = Math.imul(hi, 0x01000193) + Math.imul(lo, 0) + Math.floor((lo * 0x01000193) / 0x100000000);
		lo = loMul >>> 0;
		hi = hiMul >>> 0;
	}
	return (hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0'));
}

export function highlightId(book: string, text: string, kind: string): string {
	return fingerprint(`v1|${book}|${kind}|${normalizeText(text).toLowerCase()}`);
}

export function decodeEntities(value: string): string {
	return value
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)));
}

export function stripTags(html: string): string {
	return decodeEntities(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
}
