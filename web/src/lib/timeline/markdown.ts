// Discord-flavoured markdown and mention tokens, parsed into a tree the renderer turns into DOM nodes

export type Inline =
	| { kind: 'text'; text: string }
	| { kind: 'link'; href: string; text: string }
	| { kind: 'code'; text: string }
	| { kind: 'bold'; children: Inline[] }
	| { kind: 'italic'; children: Inline[] }
	| { kind: 'strike'; children: Inline[] }
	| { kind: 'underline'; children: Inline[] }
	| { kind: 'spoiler'; children: Inline[] }
	| { kind: 'user'; id: string }
	| { kind: 'channel'; id: string }
	| { kind: 'role'; id: string }
	| { kind: 'everyone'; text: string }
	| { kind: 'emoji'; id: string; name: string; animated: boolean }
	| { kind: 'timestamp'; unix: number; style: string };

export type Block =
	| { kind: 'paragraph'; children: Inline[] }
	| { kind: 'quote'; children: Inline[] }
	| { kind: 'subtext'; children: Inline[] }
	| { kind: 'heading'; level: number; children: Inline[] }
	| { kind: 'codeblock'; lang: string; text: string };

const URL_PATTERN = /^https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]}]/;
const TOKEN_PATTERN = /^<(a?):(\w+):(\d+)>|^<@!?(\d+)>|^<#(\d+)>|^<@&(\d+)>|^<t:(-?\d+)(?::([tTdDfFR]))?>/;

const wrappers: { marker: string; kind: 'bold' | 'italic' | 'strike' | 'underline' | 'spoiler' }[] = [
	{ marker: '||', kind: 'spoiler' },
	{ marker: '~~', kind: 'strike' },
	{ marker: '__', kind: 'underline' },
	{ marker: '**', kind: 'bold' },
	{ marker: '*', kind: 'italic' },
	{ marker: '_', kind: 'italic' }
];

// Parses inline markup, leaving anything unbalanced as literal text
export function parseInline(text: string): Inline[] {
	const out: Inline[] = [];
	let buffer = '';
	const flush = () => {
		if (buffer) out.push({ kind: 'text', text: buffer });
		buffer = '';
	};
	let i = 0;
	while (i < text.length) {
		const rest = text.slice(i);
		if (rest.startsWith('\\') && rest.length > 1) {
			buffer += rest[1];
			i += 2;
			continue;
		}
		const token = TOKEN_PATTERN.exec(rest);
		if (token) {
			flush();
			if (token[3]) out.push({ kind: 'emoji', id: token[3], name: token[2], animated: token[1] === 'a' });
			else if (token[4]) out.push({ kind: 'user', id: token[4] });
			else if (token[5]) out.push({ kind: 'channel', id: token[5] });
			else if (token[6]) out.push({ kind: 'role', id: token[6] });
			else out.push({ kind: 'timestamp', unix: Number(token[7]), style: token[8] ?? 'f' });
			i += token[0].length;
			continue;
		}
		if (rest.startsWith('@everyone') || rest.startsWith('@here')) {
			flush();
			const word = rest.startsWith('@everyone') ? '@everyone' : '@here';
			out.push({ kind: 'everyone', text: word });
			i += word.length;
			continue;
		}
		const url = URL_PATTERN.exec(rest);
		if (url && (i === 0 || /[\s(<]/.test(text[i - 1]))) {
			flush();
			out.push({ kind: 'link', href: url[0], text: url[0] });
			i += url[0].length;
			continue;
		}
		if (rest.startsWith('`')) {
			const close = rest.indexOf('`', 1);
			if (close > 1) {
				flush();
				out.push({ kind: 'code', text: rest.slice(1, close) });
				i += close + 1;
				continue;
			}
		}
		let wrapped = false;
		for (const { marker, kind } of wrappers) {
			if (!rest.startsWith(marker)) continue;
			const inner = rest.slice(marker.length);
			const close = findClose(inner, marker);
			if (close <= 0) continue;
			flush();
			out.push({ kind, children: parseInline(inner.slice(0, close)) });
			i += marker.length + close + marker.length;
			wrapped = true;
			break;
		}
		if (wrapped) continue;
		buffer += text[i];
		i++;
	}
	flush();
	return out;
}

// Finds a closing marker that is not immediately preceded by whitespace, as Discord requires
function findClose(inner: string, marker: string): number {
	let from = 0;
	for (;;) {
		const at = inner.indexOf(marker, from);
		if (at < 0) return -1;
		if (at > 0 && !/\s/.test(inner[at - 1])) return at;
		if (at === 0) return -1;
		from = at + 1;
	}
}

// Splits message text into blocks, keeping fenced code verbatim
export function parseBlocks(text: string): Block[] {
	const out: Block[] = [];
	const lines = text.replaceAll('\r\n', '\n').split('\n');
	let paragraph: string[] = [];
	const flushParagraph = () => {
		if (paragraph.length) out.push({ kind: 'paragraph', children: parseInline(paragraph.join('\n')) });
		paragraph = [];
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith('```')) {
			flushParagraph();
			const lang = line.slice(3).trim();
			const body: string[] = [];
			let closed = false;
			for (i++; i < lines.length; i++) {
				if (lines[i].startsWith('```')) {
					closed = true;
					break;
				}
				body.push(lines[i]);
			}
			if (!closed && body.length === 0 && lang) {
				out.push({ kind: 'codeblock', lang: '', text: lang });
			} else {
				out.push({ kind: 'codeblock', lang, text: body.join('\n') });
			}
			continue;
		}
		const heading = /^(#{1,3}) (.+)$/.exec(line);
		if (heading) {
			flushParagraph();
			out.push({ kind: 'heading', level: heading[1].length, children: parseInline(heading[2]) });
			continue;
		}
		if (line.startsWith('-# ')) {
			flushParagraph();
			out.push({ kind: 'subtext', children: parseInline(line.slice(3)) });
			continue;
		}
		if (line.startsWith('> ') || line === '>') {
			flushParagraph();
			const quote = [line.slice(2)];
			while (i + 1 < lines.length && (lines[i + 1].startsWith('> ') || lines[i + 1] === '>')) {
				i++;
				quote.push(lines[i].slice(2));
			}
			out.push({ kind: 'quote', children: parseInline(quote.join('\n')) });
			continue;
		}
		paragraph.push(line);
	}
	flushParagraph();
	return out;
}

export function emojiUrl(id: string, animated: boolean): string {
	return `https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'webp'}?size=44`;
}

// Resolves mention ids to names, provided by the channel page from its member and channel queries
export interface MentionResolver {
	user(id: string): { name: string; color?: string } | undefined;
	channel(id: string): { name: string; href: string } | undefined;
	role(id: string): { name: string; color?: string } | undefined;
}

export const noMentions: MentionResolver = {
	user: () => undefined,
	channel: () => undefined,
	role: () => undefined
};

const timestampFormats: Record<string, Intl.DateTimeFormatOptions> = {
	t: { timeStyle: 'short' },
	T: { timeStyle: 'medium' },
	d: { dateStyle: 'short' },
	D: { dateStyle: 'long' },
	f: { dateStyle: 'long', timeStyle: 'short' },
	F: { dateStyle: 'full', timeStyle: 'short' }
};

export function formatTimestamp(unix: number, style: string, now = Date.now()): string {
	const date = new Date(unix * 1000);
	if (style === 'R') {
		const rel = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
		const seconds = Math.round((date.getTime() - now) / 1000);
		const units: [Intl.RelativeTimeFormatUnit, number][] = [
			['second', 60],
			['minute', 60],
			['hour', 24],
			['day', 30],
			['month', 12]
		];
		let value = seconds;
		for (const [unit, size] of units) {
			if (Math.abs(value) < size) return rel.format(value, unit);
			value = Math.round(value / size);
		}
		return rel.format(value, 'year');
	}
	return new Intl.DateTimeFormat(undefined, timestampFormats[style] ?? timestampFormats.f).format(date);
}
