import type { Attachment } from 'svelte/attachments';

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]}]/g;

export interface Segment {
	text: string;
	href?: string;
}

// Splits text into plain runs and http links
export function segments(text: string): Segment[] {
	const out: Segment[] = [];
	let last = 0;
	for (const match of text.matchAll(URL_PATTERN)) {
		const at = match.index ?? 0;
		if (at > last) out.push({ text: text.slice(last, at) });
		out.push({ text: match[0], href: match[0] });
		last = at + match[0].length;
	}
	if (last < text.length) out.push({ text: text.slice(last) });
	return out;
}

// Renders text into an element with clickable links built from DOM nodes, never from HTML strings
export function linkify(text: string): Attachment<HTMLElement> {
	return (node) => {
		node.replaceChildren(
			...segments(text).map((s) => {
				if (!s.href) return document.createTextNode(s.text);
				const a = document.createElement('a');
				a.href = s.href;
				a.textContent = s.text;
				a.target = '_blank';
				a.rel = 'noopener noreferrer';
				a.className = 'text-link hover:underline';
				return a;
			})
		);
	};
}
