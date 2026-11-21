/** Import result text shown in the notice. Pure, no `obsidian` import. */

export function plural(n: number, word: string): string {
	return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

export interface SummaryInput {
	name: string;
	added: number;
	books: number;
	created: number;
	updated: number;
	already: number;
	duplicates: number;
	bookmarks: number;
	unreadable: number;
	/** Advice from the parser that is not an unreadable entry (e.g. Kobo WAL hint). */
	warnings?: string[];
}

/** Plain-language result. Example: "Added 3 highlights to 2 books (1 new note). Skipped 2 duplicates and 1 bookmark." */
export function importSummary(s: SummaryInput): string {
	const lines: string[] = [];
	if (!s.added) {
		lines.push(`No new highlights in “${s.name}”. ${s.books === 1 ? 'That book is' : s.books === 2 ? 'Both books are' : `All ${s.books.toLocaleString('en-US')} books are`} already up to date.`);
	} else {
		const notes: string[] = [];
		if (s.created) notes.push(`${plural(s.created, 'new note')}`);
		if (s.updated) notes.push(`${plural(s.updated, 'note')} updated`);
		const touched = s.created + s.updated;
		lines.push(`Added ${plural(s.added, 'highlight')} to ${plural(touched, 'book')}${notes.length ? ` (${notes.join(', ')})` : ''}.`);
	}
	const skipped: string[] = [];
	if (s.added && s.already) skipped.push(`${s.already.toLocaleString('en-US')} already in your notes`);
	if (s.added && s.duplicates) skipped.push(plural(s.duplicates, 'duplicate'));
	if (s.added && s.bookmarks) skipped.push(plural(s.bookmarks, 'bookmark'));
	if (skipped.length) lines.push(`Skipped ${joinList(skipped)}.`);
	if (s.unreadable) lines.push(`${plural(s.unreadable, 'entry')} could not be read.`.replace('entrys', 'entries'));
	for (const w of s.warnings ?? []) lines.push(w);
	return lines.join('\n');
}

export interface EmptyResultInput {
	name: string;
	/** "Kobo", "KOReader", "Kindle clippings"… */
	formatLabel: string;
	bookmarks: number;
	skipBookmarks: boolean;
	damaged?: boolean;
	reason?: string;
	warnings?: string[];
}

/** Notice text when an export produced nothing to import. Technical parser details go to the console, not here. */
export function emptyResultMessage(s: EmptyResultInput): string {
	if (s.damaged) {
		const tip = s.formatLabel === 'Kobo' ? ' Eject the Kobo safely, then copy KoboReader.sqlite again.' : ' Copy or export it from your device again.';
		return `“${s.name}” could not be read. The ${s.formatLabel} file looks damaged or incomplete.${tip}`;
	}
	if (s.bookmarks && s.skipBookmarks) {
		return `“${s.name}” has ${plural(s.bookmarks, 'bookmark')} but no highlights. Bookmarks are skipped; you can change that in Settings → Passagewise.`;
	}
	const reason = s.warnings?.[0] ?? (s.reason ? `${s.reason.replace(/[.\s]+$/, '')}.` : '');
	return `No highlights found in “${s.name}”.${reason ? ` ${reason}` : ''}`;
}

function joinList(items: string[]): string {
	if (items.length <= 1) return items.join('');
	return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
