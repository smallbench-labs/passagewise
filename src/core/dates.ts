const MONTHS: Record<string, number> = {
	january: 1, jan: 1, janvier: 1, enero: 1, gennaio: 1, janeiro: 1, januar: 1, stycznia: 1,
	february: 2, feb: 2, février: 2, fevrier: 2, febrero: 2, febbraio: 2, fevereiro: 2, februar: 2,
	march: 3, mar: 3, mars: 3, marzo: 3, março: 3, marco: 3, märz: 3, marz: 3, marca: 3,
	april: 4, apr: 4, avril: 4, abril: 4, aprile: 4, kwietnia: 4,
	may: 5, mai: 5, mayo: 5, maggio: 5, maio: 5, maja: 5,
	june: 6, jun: 6, juin: 6, junio: 6, giugno: 6, junho: 6, juni: 6, czerwca: 6,
	july: 7, jul: 7, juillet: 7, julio: 7, luglio: 7, julho: 7, juli: 7, lipca: 7,
	august: 8, aug: 8, août: 8, aout: 8, agosto: 8, sierpnia: 8,
	september: 9, sep: 9, sept: 9, septembre: 9, septiembre: 9, settembre: 9, setembro: 9, września: 9,
	october: 10, oct: 10, octobre: 10, octubre: 10, ottobre: 10, outubro: 10, oktober: 10, października: 10,
	november: 11, nov: 11, novembre: 11, noviembre: 11, novembro: 11, listopada: 11,
	december: 12, dec: 12, décembre: 12, decembre: 12, diciembre: 12, dicembre: 12, dezembro: 12, dezember: 12, grudnia: 12,
};

function pad(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

function iso(year: number, month: number, day: number, hour: number, minute: number, second: number): string | undefined {
	if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
	if (hour > 23 || minute > 59 || second > 59) return undefined;
	return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

function applyAmPm(hour: number, meridiem: string | undefined): number {
	if (!meridiem) return hour;
	const m = meridiem.toLowerCase();
	if (m === 'pm' || m === '下午' || m === '晚上' || m === '午後' || m === '午後') {
		return hour === 12 ? 12 : hour + 12;
	}
	if (m === 'am' || m === '上午' || m === '凌晨' || m === '午前') {
		return hour === 12 ? 0 : hour;
	}
	return hour;
}

/** Best-effort parse of Kindle locale timestamps. Returns a timezone-naive ISO string, or undefined. */
export function parseAddedDate(raw: string): string | undefined {
	const value = raw.trim();
	if (!value) return undefined;

	const ymd = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(value);
	if (ymd) {
		const mer = /(上午|下午|晚上|凌晨|午前|午後|AM|PM)/i.exec(value);
		const time = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(value);
		const hour = time ? applyAmPm(Number(time[1]), mer?.[1]) : 0;
		return iso(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]), hour, time ? Number(time[2]) : 0, time && time[3] ? Number(time[3]) : 0);
	}

	const numeric = /(\d{1,2})[./](\d{1,2})[./](\d{4})/.exec(value);
	const time = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(value);
	const mer = /\b(AM|PM)\b/i.exec(value);
	if (numeric && /\d{1,2}\.\s*\S+/.test(value) === false) {
		// Ambiguous d/m/y vs m/d/y; Kindle DE uses 14. Juni, not 14.6.2018 with dots only sometimes.
	}

	const german = /(\d{1,2})\.\s*([A-Za-zäöüÄÖÜ]+)\s+(\d{4})/.exec(value);
	if (german) {
		const month = MONTHS[german[2].toLowerCase()];
		if (month) {
			const hour = time ? applyAmPm(Number(time[1]), mer?.[1]) : 0;
			return iso(Number(german[3]), month, Number(german[1]), hour, time ? Number(time[2]) : 0, time && time[3] ? Number(time[3]) : 0);
		}
	}

	const dayMonthYear = /(\d{1,2})\s+([A-Za-zàáâäçéèêëíîïñóôöúùûüÀÁÂÄÇÉÈÊËÍÎÏÑÓÔÖÚÙÛÜ.]+)\s+(\d{4})/.exec(value);
	if (dayMonthYear) {
		const month = MONTHS[dayMonthYear[2].toLowerCase().replace(/\.$/, '')];
		if (month) {
			const hour = time ? applyAmPm(Number(time[1]), mer?.[1]) : 0;
			return iso(Number(dayMonthYear[3]), month, Number(dayMonthYear[1]), hour, time ? Number(time[2]) : 0, time && time[3] ? Number(time[3]) : 0);
		}
	}

	const monthDayYear = /([A-Za-z.]+)\s+(\d{1,2}),\s*(\d{4})/.exec(value);
	if (monthDayYear) {
		const month = MONTHS[monthDayYear[1].toLowerCase().replace(/\.$/, '')];
		if (month) {
			const hour = time ? applyAmPm(Number(time[1]), mer?.[1]) : 0;
			return iso(Number(monthDayYear[3]), month, Number(monthDayYear[2]), hour, time ? Number(time[2]) : 0, time && time[3] ? Number(time[3]) : 0);
		}
	}

	const isoLike = /(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value);
	if (isoLike) {
		return iso(Number(isoLike[1]), Number(isoLike[2]), Number(isoLike[3]), Number(isoLike[4] || 0), Number(isoLike[5] || 0), Number(isoLike[6] || 0));
	}

	return undefined;
}

export function stripDatePrefix(metaTail: string): string {
	const prefixes = [
		/^added on\s+/i,
		/^añadido el\s+/i,
		/^agregado el\s+/i,
		/^hinzugefügt am\s+/i,
		/^ajouté le\s+/i,
		/^aggiunto il\s+/i,
		/^adicionado (?:em|a)\s+/i,
		/^dodano\s+/i,
		/^přidáno\s+/i,
		/^добавлено\s+/i,
		/^添加[于於]\s*/,
		/^新增[于於]\s*/,
		/^作成日[:：]?\s*/,
		/^追加(?:された)?日[:：]?\s*/,
		/^added[:：]?\s+/i,
	];
	let value = metaTail.trim();
	for (const prefix of prefixes) {
		if (prefix.test(value)) {
			value = value.replace(prefix, '').trim();
			break;
		}
	}
	return value;
}
