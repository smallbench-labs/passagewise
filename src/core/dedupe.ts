import { Highlight } from './model';
import { rangesOverlap } from './parseClippings';
import { normalizeText } from './text';

function norm(text: string): string {
	return normalizeText(text).toLowerCase();
}

function longerText(a: Highlight, b: Highlight): Highlight {
	return (a.text || a.note).length >= (b.text || b.note).length ? a : b;
}

function mergeInto(keep: Highlight, drop: Highlight): Highlight {
	if (keep.id !== drop.id && !keep.aliases.includes(drop.id)) keep.aliases.push(drop.id);
	for (const alias of drop.aliases) {
		if (alias !== keep.id && !keep.aliases.includes(alias)) keep.aliases.push(alias);
	}
	if (!keep.note && drop.note) keep.note = drop.note;
	else if (keep.note && drop.note && norm(keep.note) !== norm(drop.note) && !norm(keep.note).includes(norm(drop.note))) {
		keep.note = `${keep.note.trim()}\n\n${drop.note.trim()}`;
	}
	if (!keep.text && drop.text) keep.text = drop.text;
	if (keep.text && drop.text && drop.text.length > keep.text.length) keep.text = drop.text;
	if (keep.page == null && drop.page != null) keep.page = drop.page;
	if (!keep.location.start && drop.location.start) keep.location = drop.location;
	if (!keep.chapter && drop.chapter) keep.chapter = drop.chapter;
	if (!keep.color && drop.color) keep.color = drop.color;
	if (!keep.addedAt && drop.addedAt) keep.addedAt = drop.addedAt;
	if (!keep.addedAtRaw && drop.addedAtRaw) keep.addedAtRaw = drop.addedAtRaw;
	if (!keep.authors && drop.authors) keep.authors = drop.authors;
	return keep;
}

function containsText(longer: string, shorter: string): boolean {
	if (shorter.length < 16) return false;
	return longer.includes(shorter);
}

/** Per-item features, computed once (normalisation is the expensive part). */
interface Features {
	norm: string;
	words: Set<string>;
	/** Words and CJK character pairs, used only to find candidates. */
	tokens: string[];
	/** Interior tokens (first and last word dropped), for the rarest-token signature. */
	interior: string[];
}

const CJK_RUN = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]{2,}/g;

function features(item: Highlight): Features {
	const n = norm(item.text || item.note);
	const list = n.split(' ').filter((w) => w.length > 1);
	const words = new Set(list);
	const pairs: string[] = [];
	for (const run of n.match(CJK_RUN) || []) {
		for (let i = 0; i + 1 < run.length; i++) pairs.push(`\u0001${run.slice(i, i + 2)}`);
	}
	const interiorWords = list.length >= 5 ? list.slice(1, -1) : list;
	return { norm: n, words, tokens: [...words, ...new Set(pairs)], interior: [...new Set(interiorWords), ...new Set(pairs)] };
}

function similarF(a: Features, b: Features): boolean {
	if (!a.norm || !b.norm) return false;
	if (a.norm === b.norm) return true;
	if (a.norm.length >= 16 && b.norm.length >= 16 && (a.norm.includes(b.norm) || b.norm.includes(a.norm))) return true;
	if (a.words.size === 0 || b.words.size === 0) return false;
	const [small, big] = a.words.size <= b.words.size ? [a.words, b.words] : [b.words, a.words];
	if (small.size / big.size < 0.6) return false;
	let inter = 0;
	for (const w of small) if (big.has(w)) inter += 1;
	return inter / small.size >= 0.9 && inter / big.size >= 0.6;
}

export interface DedupeResult {
	highlights: Highlight[];
	skipped: number;
}

/**
 * Same rules as before (exact ID, contained text, adjusted range + similar text, similar text on the same page),
 * but candidates come from an inverted index instead of comparing every pair.
 *
 * Signature: an item's floor(10% of its words) + 1 rarest interior tokens. If two items pass similarF(), the smaller
 * one has at least 90% of its words in the larger one, so at least one of its signature tokens is among the larger
 * item's tokens; a contained text shares all of its interior words. New items look up their signature in the token
 * index (smaller item is new) and their tokens in the signature index (smaller item is already kept), so every pair
 * the pairwise version would merge is still compared, while staying near-linear on real text.
 */
export function dedupeHighlights(items: Highlight[]): DedupeResult {
	const byBook = new Map<string, Highlight[]>();
	for (const item of items) {
		const list = byBook.get(item.bookKey) || [];
		list.push(item);
		byBook.set(item.bookKey, list);
	}
	const highlights: Highlight[] = [];
	for (const group of byBook.values()) highlights.push(...dedupeGroup(group));
	return { highlights, skipped: Math.max(0, items.length - highlights.length) };
}

function dedupeGroup(group: Highlight[]): Highlight[] {
	const feats = new Map<Highlight, Features>();
	const df = new Map<string, number>();
	for (const item of group) {
		const f = features(item);
		feats.set(item, f);
		for (const t of f.tokens) df.set(t, (df.get(t) || 0) + 1);
	}
	const signature = (f: Features): string[] => {
		const k = Math.floor(f.words.size * 0.1) + 1;
		const pool = f.interior.length >= k ? f.interior : f.tokens;
		const words = pool.filter((t) => t.charCodeAt(0) !== 1).sort((x, y) => (df.get(x) || 0) - (df.get(y) || 0)).slice(0, k);
		const pairs = pool.filter((t) => t.charCodeAt(0) === 1).sort((x, y) => (df.get(x) || 0) - (df.get(y) || 0)).slice(0, 2);
		return [...words, ...pairs];
	};

	const kept: Highlight[] = [];
	const keptFeats: Features[] = [];
	const byId = new Map<string, number>();
	const tokenIndex = new Map<string, number[]>();
	const sigIndex = new Map<string, number[]>();
	const push = (index: Map<string, number[]>, key: string, slot: number) => {
		const list = index.get(key);
		if (list) { if (list[list.length - 1] !== slot) list.push(slot); } else index.set(key, [slot]);
	};
	const register = (slot: number, item: Highlight, f: Features) => {
		for (const id of [item.id, ...item.aliases]) byId.set(id, slot);
		if (item.kind === 'bookmark') return;
		for (const t of f.tokens) push(tokenIndex, t, slot);
		for (const t of signature(f)) push(sigIndex, t, slot);
	};
	const replaceOrMerge = (slot: number, item: Highlight, f: Features) => {
		const other = kept[slot];
		if (longerText(other, item) === item) {
			kept[slot] = mergeInto(item, other);
			keptFeats[slot] = f;
		} else {
			mergeInto(other, item);
		}
		register(slot, kept[slot], keptFeats[slot]);
	};

	for (const item of group) {
		const f = feats.get(item) as Features;
		let exact = byId.get(item.id);
		if (exact === undefined) for (const alias of item.aliases) { exact = byId.get(alias); if (exact !== undefined) break; }
		if (exact !== undefined) { replaceOrMerge(exact, item, f); continue; }

		let match = -1;
		if (item.kind !== 'bookmark' && f.norm) {
			const candidates = new Set<number>();
			for (const t of signature(f)) for (const slot of tokenIndex.get(t) || []) candidates.add(slot);
			for (const t of f.tokens) for (const slot of sigIndex.get(t) || []) candidates.add(slot);
			const ordered = [...candidates].sort((x, y) => x - y);
			for (const slot of ordered) {
				const other = kept[slot];
				if (other.kind === 'bookmark') continue;
				const g = keptFeats[slot];
				if (containsText(g.norm, f.norm) || containsText(f.norm, g.norm)
					|| (rangesOverlap(other.location, item.location) && similarF(g, f))
					|| (similarF(g, f) && (other.page == null || item.page == null || other.page === item.page))) {
					match = slot;
					break;
				}
			}
		}
		if (match !== -1) { replaceOrMerge(match, item, f); continue; }
		kept.push(item);
		keptFeats.push(f);
		register(kept.length - 1, item, f);
	}
	return kept;
}
