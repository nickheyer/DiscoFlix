import type { Attachment } from 'svelte/attachments';

// Grows a textarea with its content up to the CSS max height, tracking the given value
export function autosize(value: string): Attachment<HTMLTextAreaElement> {
	return (node) => {
		void value;
		node.style.height = 'auto';
		node.style.height = `${node.scrollHeight}px`;
	};
}
