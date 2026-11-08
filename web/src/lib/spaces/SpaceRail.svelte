<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { errorText } from '#lib/api/errors';
	import Mark from '#lib/theme/Mark.svelte';
	import { timeline } from '#lib/timeline/store.svelte';
	import * as Tooltip from '#lib/ui/tooltip';
	import { spacesQuery } from './queries';
	import SpaceIcon from './SpaceIcon.svelte';

	let { selectedId }: { selectedId: string } = $props();

	const spaces = createQuery(() => spacesQuery());
	const sorted = $derived(
		[...(spaces.data?.spaces ?? [])].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
	);
</script>

<nav
	aria-label="Spaces"
	class="flex h-full w-[72px] shrink-0 flex-col items-center gap-2 overflow-y-auto bg-rail py-3 scroll-none"
>
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<a {...props} href="/" aria-label="DiscoFlix home" class="flex w-[72px] justify-center">
					<Mark size={48} class="rounded-2xl transition-[border-radius] hover:rounded-xl" />
				</a>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content side="right" sideOffset={4}>DiscoFlix</Tooltip.Content>
	</Tooltip.Root>
	<div class="mx-auto h-0.5 w-8 shrink-0 rounded bg-hover/50"></div>
	{#if spaces.isError}
		<p class="px-2 text-center text-[11px] text-dnd" title={errorText(spaces.error)}>Spaces failed to load</p>
		<button class="text-[11px] text-link hover:underline" onclick={() => spaces.refetch()}>Retry</button>
	{/if}
	{#each sorted as space (space.id)}
		<SpaceIcon
			href="/s/{space.id}"
			name={space.name}
			iconUrl={space.iconUrl}
			selected={space.id === selectedId}
			unread={timeline.state.spaces.get(space.id) ?? space.unread}
		/>
	{/each}
</nav>
