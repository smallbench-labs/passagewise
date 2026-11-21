export type HighlightKind = 'highlight' | 'note' | 'bookmark';

export type HighlightSource =
	| 'kindle-clippings'
	| 'kindle-html'
	| 'koreader-lua'
	| 'koreader-json'
	| 'kobo-sqlite';

export interface LocationRange {
	start?: number;
	end?: number;
	raw?: string;
}

export interface Highlight {
	id: string;
	aliases: string[];
	bookKey: string;
	title: string;
	authors: string;
	kind: HighlightKind;
	text: string;
	note: string;
	location: LocationRange;
	page?: number;
	chapter: string;
	color: string;
	addedAt?: string;
	addedAtRaw: string;
	source: HighlightSource;
}

export interface ParseIssue {
	message: string;
	block?: string;
}

export interface ParseResult {
	highlights: Highlight[];
	/** Entries (or the whole file) that could not be read. */
	issues: ParseIssue[];
	/** The whole file could not be parsed (cut off while copying, not valid JSON/Lua/SQLite). */
	damaged?: boolean;
	/** Advice shown to the user that is not an unreadable entry. */
	warnings?: string[];
}

export interface VaultLike {
	read(path: string): Promise<string | null>;
	write(path: string, content: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	createFolder?(path: string): Promise<void>;
}

export interface BookIndexEntry {
	path: string;
}

export type BookIndex = Record<string, BookIndexEntry>;

export interface SyncOptions {
	folder: string;
	fileNameTemplate: string;
	noteTemplate?: string;
	skipBookmarks: boolean;
	index: BookIndex;
}

export interface SyncReport {
	booksWritten: number;
	createdNotes: number;
	updatedNotes: number;
	/** Notes that already had every highlight from this import (not written). */
	unchangedNotes: number;
	newHighlights: number;
	keptHighlights: number;
	/** Highlights in this import that were already in their book note. */
	alreadyInNotes: number;
	skippedBookmarks: number;
	skippedDuplicates: number;
	paths: string[];
	/** Notes created or changed by this import, in import order. */
	changedPaths: string[];
	/** For notes that already existed: 0-based line of the first highlight added by this import. */
	firstNewLine: Record<string, number>;
	index: BookIndex;
}
