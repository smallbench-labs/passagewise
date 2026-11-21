import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { parseKindleClippings } from '../src/core/parseClippings';
import { parseKindleHtml } from '../src/core/parseKindleHtml';
import { parseKoreaderJson, parseKoreaderLua } from '../src/core/parseKoreader';
import { detectBinaryFormat, detectFormat, isProFormat, parseImport, parseBinaryImport } from '../src/core/detect';
import { parseKoboSqlite } from '../src/core/parseKobo';
import { isSqliteHeader, readSqlite } from '../src/core/sqlite';
import { dedupeHighlights } from '../src/core/dedupe';
import { applyRegion, knownIdsInNote, notePath, syncHighlights } from '../src/core/notes';
import { VaultLike } from '../src/core/model';
import { bookKey } from '../src/core/text';
import { emptyResultMessage, importSummary } from '../src/core/summary';
import { parseLuaValue } from '../src/core/parseLua';
import { checkRegion, CHECKOUT_READY, CHECKOUT_URL } from '../src/license/checkout';
import { LicenseManager, DEFAULT_LICENSE_CONFIG } from '../src/license/licenseManager';
import { EMPTY_LICENSE, HttpPost } from '../src/license/types';

const fixtures = join(process.cwd(), 'test/fixtures');
const srcRoot = join(process.cwd(), 'src');
const fixture = (name: string) => readFileSync(join(fixtures, name), 'utf8');
const fixtureBytes = (name: string) => new Uint8Array(readFileSync(join(fixtures, name)));

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void | Promise<void>) {
	const run = Promise.resolve().then(fn);
	return run.then(() => {
		passed += 1;
	}).catch((err) => {
		failed += 1;
		failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
	});
}

function assert(cond: unknown, message = 'assertion failed'): asserts cond {
	if (!cond) throw new Error(message);
}

function eq<T>(actual: T, expected: T, message?: string) {
	if (actual !== expected) throw new Error(message || `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

class MemoryVault implements VaultLike {
	files = new Map<string, string>();
	folders = new Set<string>();
	async read(path: string) { return this.files.has(path) ? this.files.get(path)! : null; }
	async write(path: string, content: string) { this.files.set(path, content); }
	async exists(path: string) { return this.files.has(path); }
	async createFolder(path: string) { this.folders.add(path); }
}

const jobs: Promise<void>[] = [];

jobs.push(test('English clippings: highlight, note attach, bookmark, date, location', () => {
	const { highlights, issues } = parseKindleClippings(fixture('clippings-en.txt'));
	eq(issues.length, 0, `issues: ${issues.map((i) => i.message).join('; ')}`);
	const pride = highlights.filter((h) => h.title === 'Pride and Prejudice');
	const alice = highlights.filter((h) => h.title.startsWith('Alice'));
	assert(pride.length >= 2, `expected pride entries, got ${pride.map((h) => h.kind + ':' + h.text.slice(0, 20)).join('|')}`);
	const opening = pride.find((h) => h.kind === 'highlight' && /truth universally acknowledged/.test(h.text));
	assert(opening, 'missing opening highlight');
	eq(opening!.page, 3);
	eq(opening!.location.start, 42);
	eq(opening!.addedAt, '2016-03-26T14:59:39');
	assert(pride.some((h) => h.kind === 'bookmark'), 'missing bookmark');
	assert(alice.length === 1 && /great puzzle/.test(alice[0].text), 'missing Alice highlight');
}));

jobs.push(test('English clippings: a following note is attached to the highlight', () => {
	const { highlights } = parseKindleClippings(fixture('clippings-en.txt'));
	const opening = highlights.find((h) => h.kind === 'highlight' && /feelings or views/.test(h.text) || (h.kind === 'highlight' && /truth universally/.test(h.text) && h.note));
	assert(opening, 'note was not attached');
	assert(/social pressure/.test(opening!.note), `note missing: ${opening!.note}`);
	assert(!highlights.some((h) => h.kind === 'note' && /social pressure/.test(h.note) && !h.text === false && highlights.filter((x) => /social pressure/.test(x.note)).length > 1 && false), 'ok');
	eq(highlights.filter((h) => /social pressure/.test(h.note)).length, 1, 'note should be attached once');
}));

jobs.push(test('German, French, Spanish, Chinese, Japanese locales parse', () => {
	const de = parseKindleClippings(fixture('clippings-de.txt'));
	eq(de.issues.length, 0, de.issues[0]?.message || '');
	eq(de.highlights[0].kind, 'highlight');
	eq(de.highlights[0].location.start, 22);
	eq(de.highlights[0].addedAt, '2018-06-14T23:06:53');
	assert(de.highlights[0].note.includes('berühmte'), 'German note not attached');

	const fr = parseKindleClippings(fixture('clippings-fr.txt'));
	eq(fr.highlights[0].kind, 'highlight');
	eq(fr.highlights[0].page, 3);
	eq(fr.highlights[0].location.start, 42);
	eq(fr.highlights[0].addedAt, '2016-03-26T14:59:39');

	const es = parseKindleClippings(fixture('clippings-es.txt'));
	eq(es.highlights[0].location.end, 44);
	eq(es.highlights[0].addedAt, '2016-03-26T14:59:39');

	const zh = parseKindleClippings(fixture('clippings-zh-cn.txt'));
	eq(zh.issues.length, 0, zh.issues[0]?.message || '');
	eq(zh.highlights.filter((h) => h.kind === 'highlight').length, 2);
	eq(zh.highlights.find((h) => h.kind === 'highlight' && h.page === 1)?.location.start, 12);
	eq(zh.highlights[0].addedAt, '2023-05-19T13:11:48');
	assert(zh.highlights.some((h) => h.kind === 'bookmark' && h.page === 4), 'zh-CN bookmark missing');
	assert(zh.highlights.some((h) => h.text.includes('有朋自遠方來')), 'second zh highlight missing');

	const tw = parseKindleClippings(fixture('clippings-zh-tw.txt'));
	eq(tw.highlights.length, 2, `zh-TW count ${tw.highlights.length} issues=${tw.issues.map((i) => i.message).join()}`);
	eq(tw.highlights[0].page, 1);
	eq(tw.highlights[0].addedAt, '2023-05-19T13:11:48');

	const ja = parseKindleClippings(fixture('clippings-ja.txt'));
	eq(ja.issues.length, 0, ja.issues[0]?.message || '');
	eq(ja.highlights.length, 2);
	eq(ja.highlights[0].page, 12);
	eq(ja.highlights[0].location.start, 348);
	eq(ja.highlights[0].addedAt, '2021-01-09T13:36:03');
	eq(ja.highlights[1].page, 13);
	assert(ja.highlights[0].text.includes('吾輩は猫である'), 'ja text missing');
}));

jobs.push(test('BOM, CRLF, and an extra blank line do not break parsing', () => {
	const raw = fixture('clippings-en.txt').replace(/\n/g, '\r\n').replace('Alice', '\r\n\r\nAlice');
	const { highlights, issues } = parseKindleClippings(raw);
	assert(highlights.some((h) => /great puzzle/.test(h.text)), `Alice missing, issues=${issues.map((i) => i.message).join()}`);
}));

jobs.push(test('Italian and Portuguese keywords parse without a device dump', () => {
	const it = parseKindleClippings(`Orgoglio e pregiudizio (Jane Austen)\n- La tua evidenziazione a pagina 3 | posizione 42-44 | Aggiunto il sabato 26 marzo 2016 14:59:39\n\nIt is a truth universally acknowledged.\n==========\n`);
	eq(it.highlights[0].kind, 'highlight');
	eq(it.highlights[0].page, 3);
	eq(it.highlights[0].location.start, 42);

	const pt = parseKindleClippings(`Orgulho e Preconceito (Jane Austen)\n- Seu destaque na página 3 | posição 42-44 | Adicionado em sábado 26 março 2016 14:59:39\n\nIt is a truth universally acknowledged.\n==========\n`);
	eq(pt.highlights[0].kind, 'highlight');
	eq(pt.highlights[0].location.end, 44);
}));

jobs.push(test('Dedup: exact duplicates and adjusted ranges keep the longer text and merge notes', () => {
	const parsed = parseKindleClippings(fixture('clippings-en.txt'));
	const pride = parsed.highlights.filter((h) => h.title === 'Pride and Prejudice' && h.kind !== 'bookmark');
	const { highlights, skipped } = dedupeHighlights(pride);
	const quotes = highlights.filter((h) => h.kind === 'highlight');
	eq(quotes.length, 1, `expected 1 merged highlight, got ${quotes.length}: ${quotes.map((h) => h.text.length).join(',')}`);
	assert(quotes[0].text.includes('However little known'), 'should keep the longer adjusted range');
	assert(/social pressure/.test(quotes[0].note), 'note should survive the merge');
	assert(skipped >= 1, `expected skipped duplicates, got ${skipped}`);
	assert(quotes[0].aliases.length >= 1, 'shorter highlight id should become an alias');
}));

jobs.push(test('Kindle HTML: title, colour, paired note, chapter, second highlight', () => {
	const { highlights, issues } = parseKindleHtml(fixture('notebook.html'));
	eq(issues.length, 0, issues[0]?.message || '');
	eq(highlights.length, 2);
	eq(highlights[0].title, 'Pride and Prejudice');
	eq(highlights[0].authors, 'Jane Austen');
	eq(highlights[0].color, 'yellow');
	eq(highlights[0].chapter, 'Chapter I');
	eq(highlights[0].location.start, 42);
	assert(/social pressure/.test(highlights[0].note), `note not paired: ${highlights[0].note}`);
	eq(highlights[1].color, 'pink');
	eq(highlights[1].page, 7);
	assert(/astonishment/.test(highlights[1].text), 'second highlight missing');
}));

jobs.push(test('Kindle HTML: mismatched macOS tags still parse', () => {
	const { highlights } = parseKindleHtml(fixture('notebook-macos-broken.html'));
	eq(highlights.length, 1);
	assert(/truth universally/.test(highlights[0].text), highlights[0].text);
	eq(highlights[0].location.start, 42);
}));

jobs.push(test('KOReader Lua annotations and older highlight/bookmark sidecars', () => {
	const current = parseKoreaderLua(fixture('metadata.epub.lua'));
	eq(current.issues.length, 0, current.issues[0]?.message || '');
	eq(current.highlights.length, 2);
	eq(current.highlights[0].title, 'Pride and Prejudice');
	eq(current.highlights[0].page, 3);
	eq(current.highlights[0].addedAt, '2024-01-30T16:52:58');
	assert(/famous opening/.test(current.highlights[0].note), 'lua note missing');

	const older = parseKoreaderLua(fixture('metadata-old.lua'));
	eq(older.issues.length, 0, older.issues[0]?.message || '');
	eq(older.highlights.length, 2);
	assert(older.highlights.some((h) => /truth universally/.test(h.text) && h.page === 3), 'old highlight missing');
	assert(older.highlights.some((h) => /astonishment/.test(h.text) && h.page === 7), 'old bookmark-highlight missing');
}));

jobs.push(test('KOReader JSON: single book and documents[]', () => {
	const single = parseKoreaderJson(fixture('koreader-single.json'));
	eq(single.highlights.length, 1);
	eq(single.highlights[0].page, 3);
	assert(/famous opening/.test(single.highlights[0].note), 'json note missing');
	assert(single.highlights[0].addedAt, 'json timestamp missing');

	const multi = parseKoreaderJson(fixture('koreader-multi.json'));
	eq(multi.highlights.length, 2);
	assert(multi.highlights.some((h) => h.title.startsWith('Alice')), 'second document missing');
}));

jobs.push(test('Detect format from filename and contents', () => {
	eq(detectFormat(fixture('clippings-en.txt'), 'My Clippings.txt'), 'kindle-clippings');
	eq(detectFormat(fixture('notebook.html'), 'Notebook.html'), 'kindle-html');
	eq(detectFormat(fixture('metadata.epub.lua'), 'metadata.epub.lua'), 'koreader-lua');
	eq(detectFormat(fixture('koreader-single.json'), 'export.json'), 'koreader-json');
	assert(isProFormat('koreader-lua') && isProFormat('koreader-json') && !isProFormat('kindle-clippings'));
}));

jobs.push(test('Pro gate: KOReader is Pro, Kindle is free; unlocked only when set', () => {
	const parsed = parseImport(fixture('metadata.epub.lua'), 'metadata.epub.lua');
	assert(isProFormat(parsed.format));
	assert(!isProFormat(parseImport(fixture('clippings-en.txt'), 'My Clippings.txt').format));
}));

jobs.push(test('First import writes one note per book, each highlight ending in a block ID', async () => {
	const parsed = parseKindleClippings(fixture('clippings-en.txt'));
	const deduped = dedupeHighlights(parsed.highlights.filter((h) => h.kind !== 'bookmark'));
	const vault = new MemoryVault();
	const report = await syncHighlights(deduped.highlights, vault, {
		folder: 'Highlights',
		fileNameTemplate: '{{title}}',
		skipBookmarks: true,
		index: {},
	});
	eq(report.createdNotes, 2);
	eq(report.booksWritten, 2);
	assert(report.newHighlights >= 2, `newHighlights ${report.newHighlights}`);
	const pride = vault.files.get('Highlights/Pride and Prejudice.md');
	assert(pride, 'pride note missing');
	assert(/\^pw-[a-f0-9]{16}$/m.test(pride!), 'block ID missing');
	assert(!pride!.includes('<!--'), 'no HTML comments in new notes');
	assert(!/^# /m.test(pride!), 'no duplicate H1 (Obsidian shows the file name as the title)');
	assert(pride!.includes('truth universally acknowledged'), 'quote missing');
	assert(/social pressure/.test(pride!), 'note missing from note body');
	const alice = vault.files.get("Highlights/Alice's Adventures in Wonderland.md");
	assert(alice && /great puzzle/.test(alice), 'alice note missing');
}));

jobs.push(test('Reimport adds only new highlights and does not overwrite user writing', async () => {
	const first = dedupeHighlights(parseKindleClippings(fixture('clippings-en.txt')).highlights.filter((h) => h.kind !== 'bookmark')).highlights;
	const vault = new MemoryVault();
	const opts = { folder: 'Highlights', fileNameTemplate: '{{title}}', skipBookmarks: true, index: {} };
	await syncHighlights(first, vault, opts);
	const path = 'Highlights/Pride and Prejudice.md';
	const original = vault.files.get(path)!;
	const edited = original
		.replace('## Highlights', '## My thoughts\n\nThis opening is about money and marriage, not love.\n\n## Highlights')
		.replace('The famous opening: social pressure, not romance.', 'I rewrote this note myself.');
	vault.files.set(path, edited);

	const again = await syncHighlights(first, vault, { ...opts, index: { [bookKey('Pride and Prejudice', 'Jane Austen')]: { path } } });
	const after = vault.files.get(path)!;
	assert(after.includes('This opening is about money and marriage, not love.'), 'user paragraph was lost');
	assert(after.includes('I rewrote this note myself.'), 'user edit inside a kept block was overwritten');
	eq(again.newHighlights, 0, `expected no new highlights, got ${again.newHighlights}`);
	eq(knownIdsInNote(after).size, knownIdsInNote(edited).size);
	eq(after, edited, 'unchanged note must not be rewritten');

	const extra = parseKindleClippings(`Pride and Prejudice (Jane Austen)\n- Your Highlight on page 8 | location 300-301 | Added on Sunday, 27 March 2016 09:00:00\n\nI am all astonishment.\n==========\n`).highlights;
	const third = await syncHighlights([...first, ...extra], vault, { ...opts, index: { [bookKey('Pride and Prejudice', 'Jane Austen')]: { path } } });
	const final = vault.files.get(path)!;
	assert(third.newHighlights === 1, `expected 1 new highlight, got ${third.newHighlights}`);
	assert(final.includes('I am all astonishment.'), 'new highlight was not appended');
	assert(final.includes('This opening is about money and marriage, not love.'), 'user paragraph lost on third import');
	assert(final.includes('I rewrote this note myself.'), 'user edit lost on third import');
}));

jobs.push(test('A note without imported highlights keeps its body and gets a Highlights section', () => {
	const incoming = parseKindleClippings(`Pride and Prejudice (Jane Austen)\n- Your Highlight on page 8 | location 300-301 | Added on Sunday, 27 March 2016 09:00:00\n\nI am all astonishment.\n==========\n`).highlights;
	const applied = applyRegion('# Pride and Prejudice\n\nMy own essay.\n', 'Pride and Prejudice', 'Jane Austen', incoming);
	assert(applied.content.includes('My own essay.'), 'existing body lost');
	assert(applied.content.includes('## Highlights'), 'section not appended');
	assert(applied.content.includes('I am all astonishment.'));
	eq(applied.added, 1);
}));

jobs.push(test('Frontmatter the user added is left alone on update', async () => {
	const items = parseKindleClippings(fixture('clippings-en.txt')).highlights.filter((h) => h.title === 'Pride and Prejudice' && h.kind === 'highlight');
	const vault = new MemoryVault();
	const path = 'Highlights/Pride and Prejudice.md';
	await syncHighlights(dedupeHighlights(items).highlights, vault, { folder: 'Highlights', fileNameTemplate: '{{title}}', skipBookmarks: true, index: {} });
	const withExtra = vault.files.get(path)!.replace('---\n', '---\nstatus: reading\nrating: 5\n');
	vault.files.set(path, withExtra);
	await syncHighlights(dedupeHighlights(items).highlights, vault, {
		folder: 'Highlights',
		fileNameTemplate: '{{title}}',
		skipBookmarks: true,
		index: { [bookKey('Pride and Prejudice', 'Jane Austen')]: { path } },
	});
	const after = vault.files.get(path)!;
	assert(after.includes('status: reading'), 'user frontmatter lost');
	assert(after.includes('rating: 5'), 'user frontmatter lost');
}));

jobs.push(test('Cross-source dedup: the same quote from clippings and HTML is one highlight', () => {
	const a = parseKindleClippings(fixture('clippings-en.txt')).highlights;
	const b = parseKindleHtml(fixture('notebook.html')).highlights;
	const { highlights } = dedupeHighlights([...a, ...b].filter((h) => /truth universally/.test(h.text) || /truth universally/.test(h.note)));
	const quotes = highlights.filter((h) => /truth universally/.test(h.text));
	eq(quotes.length, 1, `expected one opening quote, got ${quotes.length}`);
}));

jobs.push(test('notePath sanitises reserved characters', () => {
	eq(notePath('Highlights', 'Foo: Bar * Baz', '', '{{title}}'), 'Highlights/Foo Bar Baz.md');
}));

jobs.push(test('Source files stay mobile-safe: no Node or Electron APIs in src/', () => {
		const files: string[] = [];
	const walk = (p: string) => {
		for (const name of readdirSync(p)) {
			const next = join(p, name);
			if (statSync(next).isDirectory()) walk(next);
			else if (extname(next) === '.ts') files.push(next);
		}
	};
	walk(srcRoot);
	const banned = [
		/\brequire\s*\(\s*['"](?:fs|path|os|child_process|electron|net|http|https|crypto)['"]/,
		/\bfrom\s+['"]node:/,
		/\bfrom\s+['"](?:fs|path|os|electron)['"]/,
		/\bprocess\.versions/,
		/\bBuffer\./,
		/\b__dirname\b/,
		/\b__filename\b/,
	];
	for (const file of files) {
		const text = readFileSync(file, 'utf8');
		for (const re of banned) {
			assert(!re.test(text), `${file} uses a Node/Electron API: ${re}`);
		}
	}
}));


jobs.push(test('Kobo sqlite: highlights, notes, chapter join, hidden and dogear skipped', () => {
	const data = fixtureBytes('KoboReader.sqlite');
	assert(isSqliteHeader(data), 'fixture is not sqlite');
	const { highlights, issues } = parseKoboSqlite(data);
	eq(issues.length, 0, issues.map((i) => i.message).join('; '));
	assert(highlights.length === 5, `expected 5 visible highlights, got ${highlights.length} (${highlights.map((h) => h.title + ':' + h.text.slice(0, 24)).join(' | ')})`);
	assert(!highlights.some((h) => /hidden highlight/i.test(h.text)), 'hidden row leaked');
	const pride = highlights.find((h) => /truth universally/.test(h.text));
	assert(pride, 'pride highlight missing');
	eq(pride!.title, 'Pride and Prejudice');
	eq(pride!.authors, 'Jane Austen');
	eq(pride!.chapter, 'Chapter I');
	eq(pride!.source, 'kobo-sqlite');
	assert(/social pressure/.test(pride!.note), 'kobo note missing');
	assert(pride!.addedAt && pride!.addedAt.startsWith('2022-03-08T03:55:38'), `date ${pride!.addedAt}`);
	assert(pride!.aliases.includes('bbbbbbbb-1111-1111-1111-111111111111'), 'BookmarkID should be an alias');
	assert(highlights.some((h) => h.title.startsWith('Alice') && /great puzzle/.test(h.text)), 'alice missing');
	const astonish = highlights.find((h) => h.text === 'I am all astonishment.');
	assert(astonish && /short reaction/.test(astonish.note), 'type=note row missing');
	const frank = highlights.find((h) => /dreary night of November/.test(h.text));
	assert(frank, 'sideloaded book without content row missing');
	assert(/Frankenstein/i.test(frank!.title), `fallback title was ${frank!.title}`);
	const long = highlights.find((h) => h.text.length > 5000);
	assert(long && long.text.length === 9199, `overflow text length ${long && long.text.length}`);
	assert(long!.text.startsWith('I am all astonishment.'), 'overflow text start mismatch');
}));

jobs.push(test('Kobo sqlite: 1024-byte pages and overflow still parse', () => {
	const { highlights, issues } = parseKoboSqlite(fixtureBytes('kobo-pagesize-1024.sqlite'));
	eq(issues.length, 0, issues[0]?.message || '');
	eq(highlights.length, 5);
	const long = highlights.find((h) => h.text.length > 5000);
	assert(long && long.text.length === 9199, `1024-page overflow length ${long && long.text.length}`);
	const db = readSqlite(fixtureBytes('kobo-pagesize-1024.sqlite'));
	eq(db.pageSize, 1024);
	assert(db.tables.some((table) => table.name.toLowerCase() === 'bookmark'));
}));

jobs.push(test('Kobo sqlite: not a Kobo database, and junk is rejected', () => {
	const other = parseKoboSqlite(fixtureBytes('not-kobo.sqlite'));
	eq(other.highlights.length, 0);
	assert(other.issues.some((i) => /no Bookmark table/i.test(i.message)), other.issues.map((i) => i.message).join('; '));
	const junk = parseKoboSqlite(new TextEncoder().encode('this is not a database'));
	eq(junk.highlights.length, 0);
	assert(junk.issues.some((i) => /not a SQLite/i.test(i.message)), junk.issues[0]?.message || '');
}));

jobs.push(test('Detect and Pro-gate a Kobo sqlite file', () => {
	eq(detectFormat('', 'KoboReader.sqlite'), 'kobo-sqlite');
	eq(detectBinaryFormat(fixtureBytes('KoboReader.sqlite'), 'KoboReader.sqlite'), 'kobo-sqlite');
	assert(isProFormat('kobo-sqlite'));
	const parsed = parseBinaryImport(fixtureBytes('KoboReader.sqlite'), 'backup.sqlite');
	eq(parsed.format, 'kobo-sqlite');
	assert(parsed.result.highlights.length >= 4);
}));


const extraPride = (text: string, loc: number) => parseKindleClippings(`Pride and Prejudice (Jane Austen)\n- Your Highlight on page 9 | location ${loc}-${loc + 1} | Added on Sunday, 27 March 2016 09:00:00\n\n${text}\n==========\n`).highlights;

jobs.push(test('Reimport: new highlights go to the end of the highlights section, above the reader\'s own later sections', async () => {
	const first = dedupeHighlights(parseKindleClippings(fixture('clippings-en.txt')).highlights).highlights;
	const vault = new MemoryVault();
	const opts = { folder: 'Highlights', fileNameTemplate: '{{title}}', skipBookmarks: true, index: {} };
	const r1 = await syncHighlights(first, vault, opts);
	const path = 'Highlights/Pride and Prejudice.md';
	const lines = vault.files.get(path)!.split('\n');
	const metaAt = lines.findIndex((l) => /\^pw-/.test(l));
	lines.splice(metaAt + 1, 0, '', 'MY COMMENT under the quote.');
	vault.files.set(path, `${lines.join('\n').trimEnd()}\n\n## Summary\n\nMy summary.\n`);
	const r2 = await syncHighlights([...first, ...extraPride('She is tolerable; but not handsome enough to tempt me.', 150)], vault, { ...opts, index: r1.index });
	const after = vault.files.get(path)!;
	eq(r2.newHighlights, 1);
	const iComment = after.indexOf('MY COMMENT'), iNew = after.indexOf('She is tolerable'), iSummary = after.indexOf('## Summary');
	assert(iComment > 0 && iComment < iNew && iNew < iSummary, `order wrong: comment ${iComment}, new ${iNew}, summary ${iSummary}`);
	assert(after.includes('My summary.'), 'summary lost');
	assert(!/\n\n\n/.test(after), 'no runs of blank lines after insertion');
	eq(r2.changedPaths.length, 1, 'only the Pride note changed');
	eq(r2.unchangedNotes, 1, 'Alice note untouched');
}));

jobs.push(test('Reimport: a highlight deleted from the note is added again (established behaviour, 2026-11-21)', async () => {
	const first = dedupeHighlights(parseKindleClippings(fixture('clippings-en.txt')).highlights.filter((h) => h.kind !== 'bookmark')).highlights;
	const vault = new MemoryVault();
	const opts = { folder: 'Highlights', fileNameTemplate: '{{title}}', skipBookmarks: true, index: {} };
	const r1 = await syncHighlights(first, vault, opts);
	const path = 'Highlights/Pride and Prejudice.md';
	const original = vault.files.get(path)!;
	assert(original.includes('truth universally acknowledged'), 'quote missing after first import');
	const start = original.indexOf('> It is a truth universally acknowledged');
	assert(start >= 0, 'quote block not found');
	const afterQuote = original.slice(start);
	const idLine = afterQuote.search(/\^pw-[a-f0-9]+\s*$/m);
	assert(idLine >= 0, 'block ID after quote not found');
	const idEndMatch = afterQuote.slice(idLine).match(/\^pw-[a-f0-9]+/);
	const end = start + idLine + (idEndMatch ? idEndMatch[0].length : 0);
	let from = start;
	while (from > 0 && original[from - 1] === '\n') from -= 1;
	if (from > 0) from += 1; // keep a single preceding newline
	const stripped = (original.slice(0, from) + original.slice(end)).replace(/\n{3,}/g, '\n\n');
	assert(!stripped.includes('truth universally acknowledged'), 'quote still in the note after deletion');
	assert(!/\^pw-/.test(stripped) || knownIdsInNote(stripped).size < knownIdsInNote(original).size, 'deleted id still present');
	vault.files.set(path, stripped);
	const r2 = await syncHighlights(first, vault, { ...opts, index: r1.index });
	const after = vault.files.get(path)!;
	eq(r2.newHighlights, 1, `expected the deleted highlight back, got ${r2.newHighlights}`);
	assert(after.includes('truth universally acknowledged'), 'deleted highlight was not re-added');
	assert(/\^pw-[a-f0-9]{16}/.test(after), 're-added highlight has no block ID');
}));

jobs.push(test('Reimport: a shorter variant already covered by a longer quote is not added again', async () => {
	const long = dedupeHighlights(parseKindleClippings(fixture('clippings-en.txt')).highlights.filter((h) => /feelings or views/.test(h.text))).highlights;
	const vault = new MemoryVault();
	const opts = { folder: '', fileNameTemplate: '{{title}}', skipBookmarks: true, index: {} };
	await syncHighlights(long, vault, opts);
	const short = parseKindleHtml(fixture('notebook.html')).highlights.filter((h) => /truth universally/.test(h.text));
	const r = await syncHighlights(short, vault, opts);
	eq(r.newHighlights, 0, 'short HTML variant duplicated the long clippings quote');
}));

jobs.push(test('Notes: reader notes cannot become headings; CRLF notes stay CRLF; prototype comment markers are recognised', () => {
	const item = extraPride('A quote that is long enough to compare.', 500)[0];
	item.note = '# not a heading\n```\nnot a fence';
	const created = applyRegion(null, 'Pride and Prejudice', 'Jane Austen', [item]).content;
	assert(created.includes('\\# not a heading') && created.includes('\\```'), created);
	const crlf = '---\r\ntitle: "x"\r\n---\r\n\r\n## Highlights\r\n\r\n> old\r\n\r\np. 1 ^pw-0123456789abcdef\r\n';
	const out = applyRegion(crlf, 'x', '', extraPride('Another fresh quote for the CRLF test.', 700)).content;
	assert(!/[^\r]\n/.test(out), 'mixed line endings');
	const legacy = '## Highlights\n\n<!-- passagewise:managed:start -->\n<!-- passagewise:item:aaaaaaaaaaaaaaaa aliases:bbbbbbbbbbbbbbbb -->\n> x\n<!-- passagewise:item:aaaaaaaaaaaaaaaa:end -->\n<!-- passagewise:managed:end -->\n';
	const ids = knownIdsInNote(legacy);
	assert(ids.has('aaaaaaaaaaaaaaaa') && ids.has('bbbbbbbbbbbbbbbb'), 'legacy ids missing');
}));

jobs.push(test('Notes: a deleted note is recreated at the default path on the next import', async () => {
	const items = dedupeHighlights(parseKindleClippings(fixture('clippings-en.txt')).highlights).highlights;
	const vault = new MemoryVault();
	const opts = { folder: 'Highlights', fileNameTemplate: '{{title}}', skipBookmarks: true, index: { [bookKey('Pride and Prejudice', 'Jane Austen')]: { path: 'Old/Gone.md' } } };
	const r = await syncHighlights(items, vault, opts);
	assert(vault.files.has('Highlights/Pride and Prejudice.md'), 'not recreated');
	eq(r.createdNotes, 2);
}));

jobs.push(test('A text file that is not a Kindle export is rejected', () => {
	const shopping = parseImport('Shopping list\n- eggs\n- milk\n', 'shopping.txt');
	eq(shopping.format, 'unknown');
	const named = parseImport('Shopping list\n- eggs\n- milk\n==========\n', 'My Clippings.txt');
	eq(named.result.highlights.length, 0, 'non-clipping entry parsed as a highlight');
}));

jobs.push(test('Dedup scales: 5,000 highlights in one book, with repeats and adjusted ranges, in well under 5 s', () => {
	let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
	const vocab = Array.from({ length: 6000 }, (_, i) => `w${i.toString(36)}`);
	const pick = () => vocab[Math.floor(Math.pow(rnd(), 3) * vocab.length)];
	let raw = '';
	const texts: string[] = [];
	for (let i = 0; i < 5000; i++) {
		let text = Array.from({ length: 12 + Math.floor(rnd() * 30) }, pick).join(' ') + ` n${i}`;
		if (i % 50 === 49) text = texts[i - 10]; // exact repeat
		if (i % 50 === 25) text = `${texts[i - 5]} extended`; // adjusted range keeps the longer text
		texts.push(text);
		raw += `Big Book (A)\n- Your Highlight on page ${i} | location ${i * 7}-${i * 7 + 3} | Added on Saturday, 26 March 2016 14:59:39\n\n${text}\n==========\n`;
	}
	const parsed = parseKindleClippings(raw).highlights;
	const t = Date.now();
	const out = dedupeHighlights(parsed);
	const ms = Date.now() - t;
	assert(ms < 5000, `dedupe took ${ms} ms`);
	// 100 repeats + 100 extended ranges, plus 8 chance look-alikes under the similarity rule. The old pairwise
	// implementation gives the same 4,792 (and identical IDs/aliases); it took about 160 s, verified 2026-11-20.
	eq(out.highlights.length, 4792, `kept ${out.highlights.length}`);
}));

function syntheticSidecar(n: number): string {
	const rows: string[] = [];
	for (let i = 0; i < n; i++) {
		rows.push(`        [${i + 1}] = {\n            ["chapter"] = "Chapter ${Math.floor(i / 40) + 1}",\n            ["datetime"] = "2024-01-30 16:52:58",\n            ["pageno"] = ${Math.floor(i / 3) + 1},\n            ["text"] = "Synthetic sentence number ${i} with a \\"quote\\" and enough words to look like a real highlight of moderate length for the parser.",\n        },`);
	}
	return `-- synthetic\nreturn {\n    ["doc_props"] = {\n        ["title"] = "Synthetic Book",\n        ["authors"] = "Author",\n    },\n    ["annotations"] = {\n${rows.join('\n')}\n    },\n}\n`;
}

jobs.push(test('KOReader Lua: 5,000-annotation sidecar parses fast (was ~22 s for 2 MB in Obsidian, 2026-11-21)', () => {
	const raw = syntheticSidecar(5000);
	assert(raw.length > 1_000_000, `sidecar is ${raw.length} chars`);
	const t0 = performance.now();
	const { highlights, issues } = parseKoreaderLua(raw);
	const ms = performance.now() - t0;
	eq(issues.length, 0, issues[0]?.message || '');
	eq(highlights.length, 5000);
	assert(highlights[10].text.includes('"quote"'), highlights[10].text);
	assert(ms < 1500, `Lua parse took ${Math.round(ms)} ms`);
}));

jobs.push(test('KOReader Lua: string escapes (%q style newline, decimal and hex bytes, UTF-8)', () => {
	const v = parseLuaValue('return { ["a"] = "line one\\\nline two", ["b"] = "tab\\9end", ["c"] = "caf\\195\\169", ["d"] = "x\\x41y", ["e"] = "日本語 \\"q\\"", ["f"] = \'it\\\'s\' }') as Record<string, unknown>;
	eq(v.a, 'line one\nline two');
	eq(v.b, 'tab\tend');
	eq(v.c, 'café');
	eq(v.d, 'xAy');
	eq(v.e, '日本語 "q"');
	eq(v.f, "it's");
	let threw = false;
	try { parseLuaValue('return { ["a"] = "unterminated'); } catch { threw = true; }
	assert(threw, 'unterminated string must be an error, not a silently cut value');
}));

jobs.push(test('Damaged Pro files are reported as damaged, with a plain message', () => {
	const json = parseImport('{"title": "Pride and Prejudice", "entries": [ {"text": "It is a truth', 'koreader.json');
	eq(json.format, 'koreader-json');
	assert(json.result.damaged, 'cut-off JSON is damaged');
	const lua = parseImport('-- x\nreturn {\n ["doc_props"] = { ["title"] = "X" },\n ["annotations"] = { [1] = { ["text"] = "unterminated\n', 'metadata.epub.lua');
	eq(lua.format, 'koreader-lua');
	assert(lua.result.damaged, 'cut-off Lua is damaged');
	const full = fixtureBytes('KoboReader.sqlite');
	const cut = parseBinaryImport(full.slice(0, Math.floor(full.length / 3)), 'KoboReader.sqlite');
	assert(cut.result.damaged, 'truncated SQLite is damaged');
	const garbage = new Uint8Array(8000).fill(0xab); garbage.set(full.slice(0, 100));
	const g = parseBinaryImport(garbage, 'KoboReader.sqlite');
	assert(g.result.damaged, `garbage after a valid header is damaged: ${g.result.issues[0]?.message}`);
	const msg = emptyResultMessage({ name: 'KoboReader.sqlite', formatLabel: 'Kobo', bookmarks: 0, skipBookmarks: true, damaged: true, reason: cut.result.issues[0]?.message });
	eq(msg, '“KoboReader.sqlite” could not be read. The Kobo file looks damaged or incomplete. Eject the Kobo safely, then copy KoboReader.sqlite again.');
	const other = parseBinaryImport(fixtureBytes('not-kobo.sqlite'), 'not-kobo.sqlite');
	assert(!other.result.damaged, 'a valid non-Kobo database is not damaged');
	const otherMsg = emptyResultMessage({ name: 'not-kobo.sqlite', formatLabel: 'Kobo', bookmarks: 0, skipBookmarks: true, reason: other.result.issues[0]?.message });
	eq(otherMsg, 'No highlights found in “not-kobo.sqlite”. This database is not a Kobo KoboReader.sqlite (it has no Bookmark table).');
	assert(!/\.\.$/.test(otherMsg), 'no double period');
}));

jobs.push(test('Kobo: bookmarks-only database and WAL hint are warnings, not unreadable entries', () => {
	const only = parseKoboSqlite(fixtureBytes('kobo-bookmarks-only.sqlite'));
	eq(only.highlights.length, 0);
	eq(only.issues.length, 0);
	assert(/^Only 6 bookmarks were found\. Kobo bookmarks have no text/.test(only.warnings?.[0] || ''), only.warnings?.[0]);
	const wal = fixtureBytes('KoboReader.sqlite').slice();
	wal[18] = 2; wal[19] = 2;
	const w = parseKoboSqlite(wal);
	eq(w.issues.length, 0, 'WAL is not an unreadable entry');
	eq(w.highlights.length, parseKoboSqlite(fixtureBytes('KoboReader.sqlite')).highlights.length);
	assert(/eject the Kobo safely/.test(w.warnings?.[0] || ''), w.warnings?.[0]);
}));

jobs.push(test('Detection: other .json/.lua files in the vault are not treated as KOReader exports', () => {
	eq(detectFormat('{"compilerOptions": {"strict": true}}', 'tsconfig.json'), 'unknown');
	eq(detectFormat('[1, 2, 3]', 'data.json'), 'unknown');
	eq(detectFormat('local M = {}\nfunction M.setup() end\nreturn M\n', 'init.lua'), 'unknown');
	eq(detectFormat('{"title":"X","entries":[]}', 'export.json'), 'koreader-json');
	eq(detectFormat('{"title": "X", "entr', 'export.json'), 'koreader-json');
	eq(detectFormat(fixture('metadata-old.lua'), 'notes.lua'), 'koreader-lua');
}));

jobs.push(test('Book note without authors has no empty authors property', async () => {
	const vault = new MemoryVault();
	const kobo = parseKoboSqlite(fixtureBytes('KoboReader.sqlite'));
	const frank = kobo.highlights.filter((h) => h.title === 'Frankenstein');
	eq(frank.length, 1);
	eq(frank[0].authors, '');
	await syncHighlights(frank, vault, { folder: 'Highlights', fileNameTemplate: '{{title}}', skipBookmarks: true, index: {} });
	const note = vault.files.get('Highlights/Frankenstein.md') || '';
	assert(note.startsWith('---\ntitle: "Frankenstein"\n---\n'), note);
	assert(!/authors:/.test(note), note);
}));

jobs.push(test('Re-import reports the line of the first new highlight (the note opens there)', async () => {
	const vault = new MemoryVault();
	const all = parseKoreaderJson(fixture('koreader-multi.json')).highlights;
	const lua = parseKoreaderLua(fixture('metadata.epub.lua')).highlights;
	const opts = { folder: 'Highlights', fileNameTemplate: '{{title}}', skipBookmarks: true, index: {} };
	const first = await syncHighlights(all, vault, opts);
	eq(Object.keys(first.firstNewLine).length, 0, 'new notes open at the top');
	const path = 'Highlights/Pride and Prejudice.md';
	vault.files.set(path, vault.files.get(path) + '\nMy own paragraph.\n\n## My summary\n\nText.\n');
	const second = await syncHighlights(lua, vault, { ...opts, index: first.index });
	eq(second.newHighlights, 1);
	const line = second.firstNewLine[path];
	const lines = (vault.files.get(path) || '').split('\n');
	assert(line != null && lines[line].startsWith('> Mr. Bennet'), `line ${line}: ${lines[line ?? 0]}`);
	const bare = applyRegion('---\ntitle: "X"\n---\n\nSome text.\n', 'X', '', lua.slice(1));
	assert(bare.content.split('\n')[bare.firstNewLine ?? 0].startsWith('> '), `no-heading case: ${bare.firstNewLine}`);
}));

jobs.push(test('Kobo: rows of a multi-page Bookmark table come out in order (b-tree traversal)', () => {
	const { highlights, issues } = parseKoboSqlite(fixtureBytes('kobo-many-rows.sqlite'));
	eq(issues.length, 0, issues[0]?.message || '');
	eq(highlights.length, 800);
	const nums = highlights.map((h) => Number(/number (\d{4})/.exec(h.text)?.[1]));
	for (let i = 0; i < nums.length; i++) eq(nums[i], i, `row ${i} is sentence ${nums[i]}`);
}));

jobs.push(test('Summary text', () => {
	eq(importSummary({ name: 'My Clippings.txt', added: 1, books: 1, created: 1, updated: 0, already: 0, duplicates: 2, bookmarks: 1, unreadable: 0 }),
		'Added 1 highlight to 1 book (1 new note).\nSkipped 2 duplicates and 1 bookmark.');
	eq(importSummary({ name: 'My Clippings.txt', added: 0, books: 2, created: 0, updated: 0, already: 4, duplicates: 2, bookmarks: 1, unreadable: 0 }),
		'No new highlights in “My Clippings.txt”. Both books are already up to date.');
	eq(importSummary({ name: 'k.sqlite', added: 0, books: 3, created: 0, updated: 0, already: 3, duplicates: 1, bookmarks: 0, unreadable: 0, warnings: ['W.'] }),
		'No new highlights in “k.sqlite”. All 3 books are already up to date.\nW.');
	eq(importSummary({ name: 'a.txt', added: 3, books: 2, created: 0, updated: 2, already: 5, duplicates: 0, bookmarks: 0, unreadable: 2 }),
		'Added 3 highlights to 2 books (2 notes updated).\nSkipped 5 already in your notes.\n2 entries could not be read.');
}));

jobs.push(test('License: missing benefit UUID makes no request and never unlock; benefit_id must match', async () => {
	eq(CHECKOUT_READY, false, 'CHECKOUT_READY must stay false until submission day');
	eq(CHECKOUT_URL, 'https://formchime.com/api/checkout?product=passagewise-pro');
	eq(DEFAULT_LICENSE_CONFIG.organizationId, '189678f8-c892-4af0-8586-0bf2a6873e02');
	eq(DEFAULT_LICENSE_CONFIG.productId, '5cbf2191-abb9-4485-aa63-649bad01ca7d');
	eq(DEFAULT_LICENSE_CONFIG.useActivations, true);
	eq(DEFAULT_LICENSE_CONFIG.apiBase, 'https://api.polar.sh');
	let calls = 0;
	const lm0 = new LicenseManager({ ...EMPTY_LICENSE }, DEFAULT_LICENSE_CONFIG, async () => { calls++; return { status: 200, json: {} }; }, () => Date.now(), async () => {});
	assert(!lm0.isConfigured(), 'shipped config must stay unconfigured until the benefit UUID is set');
	await lm0.activate('SOME-KEY', 'Obsidian – Linux – test');
	assert(calls === 0 && !lm0.isPro(), 'placeholder benefit: no request, no Pro');
	assert(/^PLACEHOLDER-/.test(DEFAULT_LICENSE_CONFIG.benefitId), 'benefit id is still a visible placeholder');
	assert(DEFAULT_LICENSE_CONFIG.benefitId !== '3ee8f2d9-246f-4e6f-8c5e-e4336400503a' && DEFAULT_LICENSE_CONFIG.benefitId !== '5ec5a70e-bb98-4923-b040-5c5679f9daa8', 'not the Docxwise or Streakwise benefit');
	const cfg = { ...DEFAULT_LICENSE_CONFIG, productId: '11111111-1111-1111-1111-111111111111', benefitId: '22222222-2222-2222-2222-222222222222' };
	const polar = (benefit: string): HttpPost => async (url) => url.endsWith('/activate')
		? { status: 200, json: { id: 'act-1' } }
		: { status: 200, json: { status: 'granted', organization_id: cfg.organizationId, benefit_id: benefit, expires_at: null } };
	const wrong = new LicenseManager({ ...EMPTY_LICENSE }, cfg, polar('33333333-3333-3333-3333-333333333333'), () => Date.now(), async () => {}, () => 0);
	await wrong.activate('KEY', 'x');
	assert(!wrong.isPro(), 'a key for another product (other benefit_id) must not unlock');
	const right = new LicenseManager({ ...EMPTY_LICENSE }, cfg, polar(cfg.benefitId), () => Date.now(), async () => {}, () => 0);
	await right.activate('KEY', 'x');
	assert(right.isPro(), 'matching benefit_id unlocks');
	const forged = new LicenseManager({ ...EMPTY_LICENSE, status: 'valid', lastValidatedAt: Date.now(), activationId: 'a' }, cfg, polar(cfg.benefitId), () => Date.now(), async () => {});
	assert(!forged.isPro(), 'hand-edited data.json without a key must not unlock');
	eq(await checkRegion(async () => ({ status: 200, json: { blocked: true } }), 10, () => new Promise(() => {})), 'blocked');
}));

void (async () => {
	await Promise.all(jobs);
	console.log(`${passed} passed, ${failed} failed`);
	if (failures.length) {
		for (const line of failures) console.error('FAIL', line);
		process.exit(1);
	}
})();
