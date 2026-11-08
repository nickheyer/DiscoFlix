import type { Attachment } from 'svelte/attachments';
import { emojiUrl, formatTimestamp, parseBlocks, type Block, type Inline, type MentionResolver } from './markdown';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function mentionChip(text: string, color?: string): HTMLElement {
	const chip = el('span', 'rounded bg-blurple/30 px-0.5 font-medium text-[#dee0fc] hover:bg-blurple/60', text);
	if (color) chip.style.color = color;
	return chip;
}

function renderInline(nodes: Inline[], mentions: MentionResolver): Node[] {
	return nodes.map((node) => {
		switch (node.kind) {
			case 'text':
				return document.createTextNode(node.text);
			case 'link': {
				const a = el('a', 'text-link hover:underline', node.text);
				a.href = node.href;
				a.target = '_blank';
				a.rel = 'noopener noreferrer';
				return a;
			}
			case 'code':
				return el('code', 'rounded bg-tertiary px-1 py-0.5 font-mono text-[0.85em]', node.text);
			case 'bold': {
				const b = el('strong', 'font-bold');
				b.append(...renderInline(node.children, mentions));
				return b;
			}
			case 'italic': {
				const i = el('em');
				i.append(...renderInline(node.children, mentions));
				return i;
			}
			case 'strike': {
				const s = el('s');
				s.append(...renderInline(node.children, mentions));
				return s;
			}
			case 'underline': {
				const u = el('u');
				u.append(...renderInline(node.children, mentions));
				return u;
			}
			case 'spoiler': {
				const sp = el(
					'span',
					'cursor-pointer rounded bg-tertiary text-transparent transition-colors [&.open]:bg-hover/40 [&.open]:text-inherit'
				);
				sp.setAttribute('role', 'button');
				sp.setAttribute('tabindex', '0');
				sp.setAttribute('aria-label', 'Spoiler, activate to reveal');
				sp.append(...renderInline(node.children, mentions));
				const reveal = () => sp.classList.add('open');
				sp.addEventListener('click', reveal);
				sp.addEventListener('keydown', (e) => {
					if (e.key === 'Enter' || e.key === ' ') reveal();
				});
				return sp;
			}
			case 'user': {
				const u = mentions.user(node.id);
				return mentionChip('@' + (u?.name ?? 'unknown user'), u?.color);
			}
			case 'channel': {
				const c = mentions.channel(node.id);
				if (!c) return mentionChip('#unknown channel');
				const a = el(
					'a',
					'rounded bg-blurple/30 px-0.5 font-medium text-[#dee0fc] hover:bg-blurple/60 hover:underline',
					'#' + c.name
				);
				a.href = c.href;
				return a;
			}
			case 'role': {
				const r = mentions.role(node.id);
				return mentionChip('@' + (r?.name ?? 'deleted role'), r?.color);
			}
			case 'everyone':
				return mentionChip(node.text);
			case 'emoji': {
				const img = el('img', 'inline-block size-[1.375em] align-[-0.3em]');
				img.src = emojiUrl(node.id, node.animated);
				img.alt = `:${node.name}:`;
				img.title = `:${node.name}:`;
				img.loading = 'lazy';
				return img;
			}
			case 'timestamp': {
				const t = el('time', 'rounded bg-hover/40 px-1', formatTimestamp(node.unix, node.style));
				t.dateTime = new Date(node.unix * 1000).toISOString();
				t.title = formatTimestamp(node.unix, 'F');
				return t;
			}
		}
	});
}

function renderBlock(block: Block, mentions: MentionResolver): Node {
	switch (block.kind) {
		case 'paragraph': {
			const p = el('span', 'block whitespace-pre-wrap');
			p.append(...renderInline(block.children, mentions));
			return p;
		}
		case 'quote': {
			const q = el('blockquote', 'my-0.5 border-l-4 border-hover pl-3 whitespace-pre-wrap text-normal');
			q.append(...renderInline(block.children, mentions));
			return q;
		}
		case 'subtext': {
			const s = el('span', 'block text-xs text-faint');
			s.append(...renderInline(block.children, mentions));
			return s;
		}
		case 'heading': {
			const sizes = ['text-2xl', 'text-xl', 'text-lg'];
			const h = el('span', `mt-1 block font-bold text-header ${sizes[block.level - 1] ?? 'text-lg'}`);
			h.append(...renderInline(block.children, mentions));
			return h;
		}
		case 'codeblock': {
			const pre = el(
				'pre',
				'my-1 max-w-full overflow-x-auto rounded border border-tertiary bg-tertiary p-2 font-mono text-[13px] whitespace-pre scroll-thin'
			);
			if (block.lang) pre.dataset.lang = block.lang;
			pre.append(el('code', '', block.text));
			return pre;
		}
	}
}

// Renders message markdown into DOM nodes, never from HTML strings
export function renderMarkdown(text: string, mentions: MentionResolver): Attachment<HTMLElement> {
	return (node) => {
		node.replaceChildren(...parseBlocks(text).map((block) => renderBlock(block, mentions)));
	};
}
