<script lang="ts">
	import X from '@lucide/svelte/icons/x';
	import { EMOJI_GROUPS } from './emoji';

	let { onpick, onclose }: { onpick: (emoji: string) => void; onclose: () => void } = $props();

	let custom = $state('');

	function submit(e: SubmitEvent): void {
		e.preventDefault();
		const value = custom.trim();
		if (value) onpick(value);
	}
</script>

<div
	class="w-72 rounded-lg border border-tertiary bg-floating p-2 shadow-xl"
	role="dialog"
	aria-label="Pick a reaction"
>
	<div class="mb-1 flex items-center justify-between px-1">
		<span class="text-xs font-semibold tracking-wide text-faint uppercase">Add reaction</span>
		<button aria-label="Close" onclick={onclose} class="rounded p-0.5 text-faint hover:text-normal">
			<X class="size-4" />
		</button>
	</div>
	<div class="max-h-56 overflow-y-auto scroll-thin">
		{#each EMOJI_GROUPS as group (group.label)}
			<p class="px-1 pt-1 text-[11px] font-semibold text-faint">{group.label}</p>
			<div class="grid grid-cols-8">
				{#each group.emoji as emoji (emoji)}
					<button
						onclick={() => onpick(emoji)}
						class="flex size-8 items-center justify-center rounded text-xl hover:bg-hovered"
						aria-label="React with {emoji}"
					>
						{emoji}
					</button>
				{/each}
			</div>
		{/each}
	</div>
	<form class="mt-2 flex gap-1" onsubmit={submit}>
		<input
			bind:value={custom}
			placeholder="Any emoji or name:id"
			aria-label="Custom emoji"
			class="h-8 min-w-0 flex-1 rounded bg-tertiary px-2 text-sm text-normal outline-none focus:ring-2 focus:ring-ring"
		/>
		<button type="submit" class="h-8 rounded bg-blurple px-2 text-sm font-semibold text-white hover:bg-blurple/85">
			Add
		</button>
	</form>
</div>
