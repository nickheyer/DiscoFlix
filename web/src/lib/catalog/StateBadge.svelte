<script lang="ts">
	import type { Accent } from '#lib/cards/registry';

	let { label, tone }: { label: string; tone: Accent } = $props();

	const tones: Record<Accent, string> = {
		success: 'bg-online/15 text-online',
		warning: 'bg-idle/15 text-idle',
		danger: 'bg-dnd/15 text-dnd',
		info: 'bg-blurple/20 text-blurple',
		neutral: 'bg-hover/60 text-interactive'
	};
</script>

<span
	class="inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[11px] leading-4 font-semibold whitespace-nowrap {tones[
		tone
	]}">{label}</span
>
