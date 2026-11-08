<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Accent } from './registry';

	let { accent, title, typeLabel, children }: { accent: Accent; title: string; typeLabel: string; children: Snippet } =
		$props();

	const borders: Record<Accent, string> = {
		info: 'border-l-blurple',
		success: 'border-l-online',
		warning: 'border-l-idle',
		danger: 'border-l-dnd',
		neutral: 'border-l-faint'
	};
</script>

<article class="mt-1 w-full max-w-[520px] rounded border-l-4 bg-sidebar px-3 py-2.5 {borders[accent]}">
	<h4 class="text-sm font-semibold break-words text-header">{title}</h4>
	<div class="mt-1.5 text-sm text-normal">{@render children()}</div>
	<p class="mt-2 truncate font-mono text-[11px] text-faint" title={typeLabel}>{typeLabel}</p>
</article>
