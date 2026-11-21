/**
 * Read-only SQLite table scanner for a UTF-8 database already in memory.
 * Written for Passagewise so Kobo imports do not need Node or a WASM engine.
 * It follows the public SQLite database file format (https://www.sqlite.org/fileformat.html).
 */

export interface SqliteTable {
	name: string;
	columns: string[];
	rows: Array<Record<string, SqliteValue>>;
}

export type SqliteValue = string | number | bigint | Uint8Array | null;

export interface SqliteDatabase {
	pageSize: number;
	encoding: 'utf8' | 'utf16le' | 'utf16be';
	wal: boolean;
	tables: SqliteTable[];
}

function be16(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] << 8) | bytes[offset + 1];
}

function be32(bytes: Uint8Array, offset: number): number {
	return ((bytes[offset] * 0x1000000) + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])) >>> 0;
}

function signedBe(bytes: Uint8Array, offset: number, length: number): number {
	let value = 0;
	for (let i = 0; i < length; i++) value = (value * 256) + bytes[offset + i];
	const bits = length * 8;
	const sign = 2 ** (bits - 1);
	if (value >= sign) value -= 2 ** bits;
	return value;
}

function readVarint(bytes: Uint8Array, offset: number): { value: number; next: number } {
	let value = 0;
	for (let i = 0; i < 8; i++) {
		const byte = bytes[offset + i];
		value = (value * 128) + (byte & 0x7f);
		if ((byte & 0x80) === 0) return { value, next: offset + i + 1 };
	}
	value = (value * 256) + bytes[offset + 8];
	return { value, next: offset + 9 };
}

function decodeText(bytes: Uint8Array, encoding: SqliteDatabase['encoding']): string {
	if (encoding === 'utf8') return new TextDecoder('utf-8').decode(bytes);
	if (encoding === 'utf16le') return new TextDecoder('utf-16le').decode(bytes);
	return new TextDecoder('utf-16be').decode(bytes);
}

function parseCreateColumns(sql: string): string[] {
	const start = sql.indexOf('(');
	const end = sql.lastIndexOf(')');
	if (start < 0 || end <= start) return [];
	const body = sql.slice(start + 1, end);
	const parts: string[] = [];
	let current = '';
	let depth = 0;
	for (const ch of body) {
		if (ch === '(') depth += 1;
		if (ch === ')') depth -= 1;
		if (ch === ',' && depth === 0) {
			parts.push(current.trim());
			current = '';
			continue;
		}
		current += ch;
	}
	if (current.trim()) parts.push(current.trim());
	const columns: string[] = [];
	for (const part of parts) {
		if (/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|WITHOUT)\b/i.test(part)) continue;
		const match = /^["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/.exec(part);
		if (match) columns.push(match[1]);
	}
	return columns;
}

function overflowThresholds(usable: number, kind: 'leaf' | 'interior'): { x: number; m: number } {
	// https://www.sqlite.org/fileformat.html — "B-tree Pages" / overflow
	const x = kind === 'leaf' ? usable - 35 : Math.floor(((usable - 12) * 64) / 255) - 23;
	const m = Math.floor(((usable - 12) * 32) / 255) - 23;
	return { x, m };
}

function localPayloadSize(payload: number, usable: number, kind: 'leaf' | 'interior'): number {
	const { x, m } = overflowThresholds(usable, kind);
	if (payload <= x) return payload;
	const k = m + ((payload - m) % (usable - 4));
	return k <= x ? k : m;
}

export function isSqliteHeader(data: ArrayBuffer | Uint8Array): boolean {
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
	if (bytes.length < 16) return false;
	return new TextDecoder('utf-8').decode(bytes.slice(0, 15)) === 'SQLite format 3' && bytes[15] === 0;
}

export function readSqlite(data: ArrayBuffer | Uint8Array): SqliteDatabase {
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
	if (!isSqliteHeader(bytes)) throw new Error('This file is not a SQLite database');
	if (bytes.length < 100) throw new Error('This SQLite file is truncated');

	let pageSize = be16(bytes, 16);
	if (pageSize === 1) pageSize = 65536;
	if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) throw new Error(`Unsupported SQLite page size: ${pageSize}`);

	const reserved = bytes[20];
	const usable = pageSize - reserved;
	if (usable < 100) throw new Error('This SQLite file has no usable page space');

	const encodingCode = be32(bytes, 56);
	const encoding: SqliteDatabase['encoding'] = encodingCode === 2 ? 'utf16le' : encodingCode === 3 ? 'utf16be' : 'utf8';
	if (encodingCode !== 1 && encodingCode !== 0 && encodingCode !== 2 && encodingCode !== 3) {
		throw new Error('Unsupported SQLite text encoding');
	}
	const wal = bytes[18] === 2 || bytes[19] === 2;

	const readPage = (page: number): Uint8Array => {
		if (page < 1) throw new Error(`Invalid SQLite page number: ${page}`);
		const start = (page - 1) * pageSize;
		const end = start + pageSize;
		if (end > bytes.length) throw new Error('This SQLite file is truncated');
		return bytes.subarray(start, end);
	};

	const readOverflow = (startPage: number, needed: number): Uint8Array => {
		const chunks: Uint8Array[] = [];
		let page = startPage;
		let left = needed;
		const guard = new Set<number>();
		while (page && left > 0) {
			if (guard.has(page)) throw new Error('SQLite overflow pages form a loop');
			guard.add(page);
			const raw = readPage(page);
			page = be32(raw, 0);
			const chunk = raw.subarray(4, 4 + Math.min(usable - 4, left));
			chunks.push(chunk);
			left -= chunk.length;
		}
		if (left > 0) throw new Error('SQLite overflow data is truncated');
		const out = new Uint8Array(needed);
		let offset = 0;
		for (const chunk of chunks) {
			out.set(chunk, offset);
			offset += chunk.length;
		}
		return out;
	};

	const readPayload = (page: Uint8Array, start: number, payloadSize: number, kind: 'leaf' | 'interior'): Uint8Array => {
		const local = localPayloadSize(payloadSize, usable, kind);
		const available = page.length - start;
		if (local > available) throw new Error('SQLite cell payload is truncated');
		const first = page.subarray(start, start + local);
		if (payloadSize <= local) return first;
		if (local + 4 > available) throw new Error('SQLite cell payload is truncated');
		const overflowPage = be32(page, start + local);
		const rest = readOverflow(overflowPage, payloadSize - local);
		const out = new Uint8Array(payloadSize);
		out.set(first, 0);
		out.set(rest, first.length);
		return out;
	};

	const parseRecord = (payload: Uint8Array): SqliteValue[] => {
		const header = readVarint(payload, 0);
		const headerEnd = header.value;
		let offset = header.next;
		const serials: number[] = [];
		while (offset < headerEnd) {
			const next = readVarint(payload, offset);
			serials.push(next.value);
			offset = next.next;
		}
		const values: SqliteValue[] = [];
		let dataAt = headerEnd;
		for (const serial of serials) {
			if (serial === 0) { values.push(null); continue; }
			if (serial === 8) { values.push(0); continue; }
			if (serial === 9) { values.push(1); continue; }
			if (serial === 1) { values.push(signedBe(payload, dataAt, 1)); dataAt += 1; continue; }
			if (serial === 2) { values.push(signedBe(payload, dataAt, 2)); dataAt += 2; continue; }
			if (serial === 3) { values.push(signedBe(payload, dataAt, 3)); dataAt += 3; continue; }
			if (serial === 4) { values.push(signedBe(payload, dataAt, 4)); dataAt += 4; continue; }
			if (serial === 5) { values.push(signedBe(payload, dataAt, 6)); dataAt += 6; continue; }
			if (serial === 6) {
				const hi = signedBe(payload, dataAt, 4);
				const lo = be32(payload, dataAt + 4);
				const n = BigInt(hi) * 0x100000000n + BigInt(lo);
				values.push(n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n);
				dataAt += 8;
				continue;
			}
			if (serial === 7) {
				const view = new DataView(payload.buffer, payload.byteOffset + dataAt, 8);
				values.push(view.getFloat64(0, false));
				dataAt += 8;
				continue;
			}
			if (serial >= 12 && serial % 2 === 0) {
				const length = (serial - 12) / 2;
				values.push(payload.subarray(dataAt, dataAt + length));
				dataAt += length;
				continue;
			}
			if (serial >= 13 && serial % 2 === 1) {
				const length = (serial - 13) / 2;
				values.push(decodeText(payload.subarray(dataAt, dataAt + length), encoding));
				dataAt += length;
				continue;
			}
			values.push(null);
		}
		return values;
	};

	const walkTable = (rootPage: number, visit: (payload: Uint8Array) => void) => {
		const stack = [rootPage];
		const seen = new Set<number>();
		while (stack.length) {
			const pageNo = stack.pop()!;
			if (seen.has(pageNo)) throw new Error('SQLite b-tree pages form a loop');
			seen.add(pageNo);
			const page = readPage(pageNo);
			const isPageOne = pageNo === 1;
			const headerAt = isPageOne ? 100 : 0;
			const flag = page[headerAt];
			const cellCount = be16(page, headerAt + 3);
			const pointerAt = headerAt + (flag === 0x05 || flag === 0x02 ? 12 : 8);
			if (flag === 0x05) {
				// Push the right-most child first and the left children in reverse, so pages pop in key (rowid) order.
				// Otherwise rows of a large table come out shuffled (5,000 Kobo highlights out of order, found 2026-11-21).
				const right = be32(page, headerAt + 8);
				if (right) stack.push(right);
				for (let i = cellCount - 1; i >= 0; i--) {
					const cell = be16(page, pointerAt + i * 2);
					const left = be32(page, cell);
					stack.push(left);
				}
				continue;
			}
			if (flag !== 0x0d) throw new Error('This SQLite file is damaged (unexpected page type)');
			for (let i = 0; i < cellCount; i++) {
				const cell = be16(page, pointerAt + i * 2);
				const size = readVarint(page, cell);
				const rowid = readVarint(page, size.next);
				const payload = readPayload(page, rowid.next, size.value, 'leaf');
				visit(payload);
			}
		}
	};

	const masterRows: Array<{ type: string; name: string; tbl: string; root: number; sql: string }> = [];
	walkTable(1, (payload) => {
		const values = parseRecord(payload);
		const type = typeof values[0] === 'string' ? values[0] : '';
		const name = typeof values[1] === 'string' ? values[1] : '';
		const tbl = typeof values[2] === 'string' ? values[2] : name;
		const root = typeof values[3] === 'number' ? values[3] : 0;
		const sql = typeof values[4] === 'string' ? values[4] : '';
		masterRows.push({ type, name, tbl, root, sql });
	});

	const tables: SqliteTable[] = [];
	for (const master of masterRows) {
		if (master.type !== 'table' || master.name.startsWith('sqlite_')) continue;
		const columns = parseCreateColumns(master.sql);
		const rows: Array<Record<string, SqliteValue>> = [];
		if (master.root) {
			walkTable(master.root, (payload) => {
				const values = parseRecord(payload);
				const row: Record<string, SqliteValue> = {};
				for (let i = 0; i < columns.length; i++) row[columns[i]] = i < values.length ? values[i] : null;
				rows.push(row);
			});
		}
		tables.push({ name: master.name, columns, rows });
	}

	return { pageSize, encoding, wal, tables };
}

export function sqliteText(value: SqliteValue | undefined): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	if (typeof value === 'bigint') return value.toString();
	return '';
}

export function findTable(db: SqliteDatabase, name: string): SqliteTable | undefined {
	const wanted = name.toLowerCase();
	return db.tables.find((table) => table.name.toLowerCase() === wanted);
}

export function column(row: Record<string, SqliteValue>, ...names: string[]): SqliteValue | undefined {
	for (const name of names) {
		if (name in row) return row[name];
		const match = Object.keys(row).find((key) => key.toLowerCase() === name.toLowerCase());
		if (match) return row[match];
	}
	return undefined;
}

