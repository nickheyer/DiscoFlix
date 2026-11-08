<script lang="ts">
	import Hash from '@lucide/svelte/icons/hash';
	import Menu from '@lucide/svelte/icons/menu';
	import PanelRight from '@lucide/svelte/icons/panel-right';
	import { shell } from '#lib/spaces/shell.svelte';
	import { mobile } from '#lib/theme/viewport.svelte';
	import * as Tooltip from '#lib/ui/tooltip';
	import { realtime } from './realtime.svelte';

	let { name, topic }: { name: string; topic: string } = $props();

	const railLabel = $derived(mobile.current ? 'Show activity' : shell.rightDocked ? 'Hide activity' : 'Show activity');
</script>

<header
	class="flex h-12 shrink-0 items-center gap-2 px-2 shadow-[0_1px_0_rgba(4,4,5,0.2),0_1.5px_0_rgba(6,6,7,0.05),0_2px_0_rgba(4,4,5,0.05)] sm:px-4"
>
	{#if mobile.current}
		<button
			aria-label="Open navigation"
			onclick={() => (shell.navOpen = true)}
			class="flex size-9 items-center justify-center rounded text-interactive hover:text-normal"
		>
			<Menu class="size-6" />
		</button>
	{/if}
	<Hash class="size-6 shrink-0 text-faint" />
	<h1 class="truncate font-semibold text-header">{name}</h1>
	{#if topic}
		<span class="mx-2 hidden h-6 w-px shrink-0 bg-divider md:block"></span>
		<p class="hidden min-w-0 flex-1 truncate text-sm text-interactive md:block" title={topic}>{topic}</p>
	{:else}
		<span class="flex-1"></span>
	{/if}
	{#if realtime.state !== 'connected'}
		<span
			class="ml-auto shrink-0 rounded bg-idle/20 px-2 py-0.5 text-xs font-semibold text-idle"
			role="status"
			title={realtime.error || undefined}
		>
			{realtime.state === 'connecting' ? 'Connecting live updates' : 'Live updates offline'}
		</span>
	{/if}
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<button
					{...props}
					aria-label={railLabel}
					aria-pressed={!mobile.current && shell.rightDocked}
					onclick={() => shell.toggleRight(mobile.current)}
					class="ml-auto flex size-9 shrink-0 items-center justify-center rounded text-interactive hover:text-normal {!mobile.current &&
					shell.rightDocked
						? 'text-header'
						: ''}"
				>
					<PanelRight class="size-6" />
				</button>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content side="bottom">{railLabel}</Tooltip.Content>
	</Tooltip.Root>
</header>
