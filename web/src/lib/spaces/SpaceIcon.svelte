<script lang="ts">
	import * as Tooltip from '#lib/ui/tooltip';
	import { initials } from '#lib/theme/identity-colors';

	let {
		href,
		name,
		iconUrl = '',
		selected,
		unread
	}: { href: string; name: string; iconUrl?: string; selected: boolean; unread: bigint } = $props();

	const pill = $derived(selected ? 'h-10' : unread > 0n ? 'h-2 group-hover:h-5' : 'h-0 group-hover:h-5');
	const badge = $derived(unread > 99n ? '99+' : unread.toString());
</script>

<Tooltip.Root>
	<Tooltip.Trigger>
		{#snippet child({ props })}
			<a
				{...props}
				{href}
				aria-label={unread > 0n ? `${name}, ${badge} unread` : name}
				aria-current={selected ? 'page' : undefined}
				class="group relative flex w-[72px] justify-center"
			>
				<span
					class="absolute top-1/2 left-0 w-1 -translate-y-1/2 rounded-r bg-header transition-all duration-150 {pill}"
				></span>
				<span
					class="relative flex size-12 items-center justify-center overflow-visible transition-all duration-150
					{selected
						? 'rounded-2xl bg-blurple text-white'
						: 'rounded-3xl bg-chat text-normal group-hover:rounded-2xl group-hover:bg-blurple group-hover:text-white'}"
				>
					{#if iconUrl}
						<img src={iconUrl} alt="" class="size-full rounded-[inherit] object-cover" />
					{:else}
						<span class="text-sm font-semibold tracking-tight">{initials(name)}</span>
					{/if}
					{#if unread > 0n}
						<span
							class="absolute -right-1 -bottom-1 min-w-5 rounded-full border-4 border-rail bg-dnd px-1 text-center text-xs leading-3 font-bold text-white"
						>
							{badge}
						</span>
					{/if}
				</span>
			</a>
		{/snippet}
	</Tooltip.Trigger>
	<Tooltip.Content side="right" sideOffset={4}>{name}</Tooltip.Content>
</Tooltip.Root>
