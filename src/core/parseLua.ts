/**
 * A small Lua table-literal reader for KOReader metadata.*.lua sidecars.
 * It does not execute Lua. Function calls and unknown syntax are rejected.
 * Written from public field names; not copied from KOReader (AGPL).
 */

export type LuaValue = null | boolean | number | string | LuaTable;
export interface LuaTable { [key: string]: LuaValue }

// Sticky regexes: match at the cursor without copying the rest of the file (the old slice() copies made a 2 MB sidecar take ~20 s).
const NUMBER_RE = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/y;

class LuaReader {
	private i = 0;
	constructor(private s: string) {}

	parse(): LuaValue {
		this.skip();
		if (this.matchWord('return')) this.skip();
		const value = this.value();
		this.skip();
		return value;
	}

	private value(): LuaValue {
		this.skip();
		if (this.peek() === '{') return this.table();
		if (this.peek() === '"' || this.peek() === "'") return this.quoted();
		if (this.peek() === '[') {
			if (this.s[this.i + 1] === '[') return this.longString();
			// Could be long string with equals: [=[ ]=]
			if (this.s[this.i + 1] === '=') return this.longString();
		}
		if (this.matchWord('true')) return true;
		if (this.matchWord('false')) return false;
		if (this.matchWord('nil')) return null;
		const num = this.number();
		if (num !== undefined) return num;
		throw new Error(`Unexpected Lua token near: ${this.s.slice(this.i, this.i + 40)}`);
	}

	private table(): LuaTable {
		this.expect('{');
		const table: LuaTable = {};
		let arrayIndex = 1;
		this.skip();
		while (this.peek() !== '}' && this.peek()) {
			this.skip();
			if (this.peek() === '}') break;
			if (this.peek() === '[') {
				this.i += 1;
				this.skip();
				const key = this.value();
				this.skip();
				this.expect(']');
				this.skip();
				this.expect('=');
				const val = this.value();
				table[luaKey(key)] = val;
			} else {
				const ident = this.identifier();
				if (ident && this.lookAheadEquals()) {
					this.skip();
					this.expect('=');
					table[ident] = this.value();
				} else if (ident) {
					// identifier already consumed but was a value? shouldn't happen often
					this.i -= ident.length;
					table[String(arrayIndex++)] = this.value();
				} else {
					table[String(arrayIndex++)] = this.value();
				}
			}
			this.skip();
			if (this.peek() === ',' || this.peek() === ';') this.i += 1;
			this.skip();
		}
		this.expect('}');
		return table;
	}

	private lookAheadEquals(): boolean {
		const saved = this.i;
		this.skip();
		const ok = this.peek() === '=';
		this.i = saved;
		return ok;
	}

	private quoted(): string {
		const quote = this.peek();
		this.i += 1;
		let out = '';
		let start = this.i;
		const s = this.s;
		// Bytes from numeric escapes (\ddd, \xXX) are collected and decoded as UTF-8 together.
		let bytes: number[] = [];
		const flushBytes = () => { if (bytes.length) { out += new TextDecoder('utf-8').decode(new Uint8Array(bytes)); bytes = []; } };
		while (this.i < s.length) {
			const ch = s[this.i];
			if (ch !== quote && ch !== '\\') { this.i += 1; continue; }
			if (this.i > start) { flushBytes(); out += s.slice(start, this.i); }
			this.i += 1;
			if (ch === quote) { flushBytes(); return out; }
			const next = s[this.i++];
			if (next >= '0' && next <= '9') {
				let digits = next;
				while (digits.length < 3 && s[this.i] >= '0' && s[this.i] <= '9') digits += s[this.i++];
				bytes.push(Number(digits) & 0xff);
			} else if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(s.slice(this.i, this.i + 2))) {
				bytes.push(parseInt(s.slice(this.i, this.i + 2), 16));
				this.i += 2;
			} else if (next === 'z') {
				flushBytes();
				while (/\s/.test(s[this.i] || '')) this.i += 1;
			} else {
				flushBytes();
				const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"', "'": "'", '\n': '\n' };
				out += map[next] ?? next ?? '';
			}
			start = this.i;
		}
		throw new Error('Unterminated Lua string');
	}

	private longString(): string {
		this.expect('[');
		let eq = 0;
		while (this.peek() === '=') {
			eq += 1;
			this.i += 1;
		}
		this.expect('[');
		if (this.peek() === '\n') this.i += 1;
		const close = ']' + '='.repeat(eq) + ']';
		const end = this.s.indexOf(close, this.i);
		if (end === -1) throw new Error('Unterminated Lua long string');
		const value = this.s.slice(this.i, end);
		this.i = end + close.length;
		return value;
	}

	private number(): number | undefined {
		NUMBER_RE.lastIndex = this.i;
		const m = NUMBER_RE.exec(this.s);
		if (!m) return undefined;
		this.i += m[0].length;
		return Number(m[0]);
	}

	private identifier(): string | null {
		IDENT_RE.lastIndex = this.i;
		const m = IDENT_RE.exec(this.s);
		if (!m) return null;
		this.i += m[0].length;
		return m[0];
	}

	private matchWord(word: string): boolean {
		if (this.s.startsWith(word, this.i) && !/[A-Za-z0-9_]/.test(this.s[this.i + word.length] || '')) {
			this.i += word.length;
			return true;
		}
		return false;
	}

	private skip() {
		for (;;) {
			while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i += 1;
			if (this.s.startsWith('--[[', this.i)) {
				const end = this.s.indexOf(']]', this.i + 4);
				this.i = end === -1 ? this.s.length : end + 2;
				continue;
			}
			if (this.s.startsWith('--', this.i)) {
				const end = this.s.indexOf('\n', this.i);
				this.i = end === -1 ? this.s.length : end + 1;
				continue;
			}
			break;
		}
	}

	private peek(): string {
		return this.s[this.i] || '';
	}

	private expect(ch: string) {
		this.skip();
		if (!this.s.startsWith(ch, this.i)) {
			throw new Error(`Expected "${ch}" near: ${this.s.slice(this.i, this.i + 40)}`);
		}
		this.i += ch.length;
	}
}

function luaKey(key: LuaValue): string {
	if (typeof key === 'string' || typeof key === 'number' || typeof key === 'boolean') return String(key);
	throw new Error('Unsupported Lua table key');
}

export function parseLuaValue(source: string): LuaValue {
	return new LuaReader(source).parse();
}

export function asTable(value: LuaValue | undefined): LuaTable | undefined {
	if (value && typeof value === 'object') return value;
	return undefined;
}

export function asString(value: LuaValue | undefined): string {
	if (typeof value === 'string' || typeof value === 'number') return String(value);
	return '';
}

export function asNumber(value: LuaValue | undefined): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
	return undefined;
}

export function tableValues(table: LuaTable | undefined): LuaTable[] {
	if (!table) return [];
	const keys = Object.keys(table).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
	const out: LuaTable[] = [];
	for (const key of keys) {
		const value = asTable(table[key]);
		if (value) out.push(value);
	}
	return out;
}
