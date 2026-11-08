<script lang="ts">
	import type { Accent } from '#lib/cards/registry';
	import { percent } from '#lib/theme/format';
	import { confidenceTone } from './states';

	let { label, ratio, text }: { label: string; ratio: number; text: string } = $props();

	const filled = $derived(percent(ratio));
	const bars: Record<Accent, string> = {
		success: 'bg-online',
		warning: 'bg-idle',
		danger: 'bg-dnd',
		info: 'bg-blurple',
		neutral: 'bg-faint'
	};
</script>

<div class="flex items-center gap-2 text-xs">
	<span class="shrink-0 text-interactive">{label}</span>
	<div
		role="meter"
		aria-label={label}
		aria-valuemin={0}
		aria-valuemax={100}
		aria-valuenow={filled}
		aria-valuetext={text}
		class="h-1.5 min-w-10 flex-1 overflow-hidden rounded-full bg-tertiary"
	>
		<div class="h-full rounded-full {bars[confidenceTone(filled / 100)]}" style:width="{filled}%"></div>
	</div>
	<span class="shrink-0 text-right font-semibold text-header tabular-nums">{text}</span>
</div>
