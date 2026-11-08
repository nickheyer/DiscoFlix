import { describe, expect, it } from 'vitest';
import { formatTimestamp, parseBlocks, parseInline } from './markdown';

describe('parseInline', () => {
	it('keeps plain text whole', () => {
		expect(parseInline('hello world')).toEqual([{ kind: 'text', text: 'hello world' }]);
	});

	it('nests bold and italic', () => {
		expect(parseInline('a **b *c* d** e')).toEqual([
			{ kind: 'text', text: 'a ' },
			{
				kind: 'bold',
				children: [
					{ kind: 'text', text: 'b ' },
					{ kind: 'italic', children: [{ kind: 'text', text: 'c' }] },
					{ kind: 'text', text: ' d' }
				]
			},
			{ kind: 'text', text: ' e' }
		]);
	});

	it('leaves unbalanced markers as text', () => {
		expect(parseInline('2 * 3 = 6')).toEqual([{ kind: 'text', text: '2 * 3 = 6' }]);
		expect(parseInline('**open')).toEqual([{ kind: 'text', text: '**open' }]);
	});

	it('parses mentions, emoji, timestamps, links, and code', () => {
		expect(parseInline('<@123> in <#456> for <@&789> <:pog:1> <a:dance:2> <t:0:R> https://x.y/z `k`')).toEqual([
			{ kind: 'user', id: '123' },
			{ kind: 'text', text: ' in ' },
			{ kind: 'channel', id: '456' },
			{ kind: 'text', text: ' for ' },
			{ kind: 'role', id: '789' },
			{ kind: 'text', text: ' ' },
			{ kind: 'emoji', id: '1', name: 'pog', animated: false },
			{ kind: 'text', text: ' ' },
			{ kind: 'emoji', id: '2', name: 'dance', animated: true },
			{ kind: 'text', text: ' ' },
			{ kind: 'timestamp', unix: 0, style: 'R' },
			{ kind: 'text', text: ' ' },
			{ kind: 'link', href: 'https://x.y/z', text: 'https://x.y/z' },
			{ kind: 'text', text: ' ' },
			{ kind: 'code', text: 'k' }
		]);
	});

	it('does not style inside code spans and honours escapes', () => {
		expect(parseInline('`**not bold**` \\*literal\\*')).toEqual([
			{ kind: 'code', text: '**not bold**' },
			{ kind: 'text', text: ' *literal*' }
		]);
	});

	it('marks everyone and spoilers', () => {
		expect(parseInline('@everyone ||secret||')).toEqual([
			{ kind: 'everyone', text: '@everyone' },
			{ kind: 'text', text: ' ' },
			{ kind: 'spoiler', children: [{ kind: 'text', text: 'secret' }] }
		]);
	});
});

describe('parseBlocks', () => {
	it('splits code fences, quotes, headings, and subtext', () => {
		const blocks = parseBlocks('# Title\n> quoted\n> more\n```js\nlet x = 1\n```\n-# small\nplain **bold**');
		expect(blocks.map((b) => b.kind)).toEqual(['heading', 'quote', 'codeblock', 'subtext', 'paragraph']);
		expect(blocks[2]).toEqual({ kind: 'codeblock', lang: 'js', text: 'let x = 1' });
		expect(blocks[1]).toEqual({ kind: 'quote', children: [{ kind: 'text', text: 'quoted\nmore' }] });
	});

	it('keeps an unterminated fence as code', () => {
		expect(parseBlocks('```\nraw')).toEqual([{ kind: 'codeblock', lang: '', text: 'raw' }]);
	});

	it('keeps newlines inside a paragraph', () => {
		expect(parseBlocks('one\ntwo')).toEqual([{ kind: 'paragraph', children: [{ kind: 'text', text: 'one\ntwo' }] }]);
	});
});

describe('formatTimestamp', () => {
	it('renders relative times from a fixed now', () => {
		const now = 1_700_000_000_000;
		expect(formatTimestamp(1_700_000_000 - 90, 'R', now)).toMatch(/minute/);
		expect(formatTimestamp(1_700_000_000 + 7200, 'R', now)).toMatch(/hour/);
	});
});
