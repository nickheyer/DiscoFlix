<script lang="ts">
	import Compass from '@lucide/svelte/icons/compass';
	import Menu from '@lucide/svelte/icons/menu';
	import Settings from '@lucide/svelte/icons/settings';
	import type { Snippet } from 'svelte';
	import { session } from '#lib/identity/session.svelte';
	import { shell } from '#lib/spaces/shell.svelte';
	import { mobile } from '#lib/theme/viewport.svelte';
	import * as Tooltip from '#lib/ui/tooltip';

	let { title, children }: { title: string; children?: Snippet } = $props();
</script>

<header
	class="flex h-12 shrink-0 items-center gap-2 px-2 shadow-[0_1px_0_rgba(4,4,5,0.2),0_1.5px_0_rgba(6,6,7,0.05),0_2px_0_rgba(4,4,5,0.05)] sm:px-4"
>
	{#if mobile.current}
		<button
			aria-label="Open navigation"
			onclick={() => (shell.navOpen = true)}
			class="flex size-9 shrink-0 items-center justify-center rounded text-interactive hover:text-normal"
		>
			<Menu class="size-6" />
		</button>
	{/if}
	<a href="/catalog" aria-label="Catalog search" class="shrink-0 text-faint hover:text-normal">
		<Compass class="size-6" />
	</a>
	<h1 class="min-w-0 flex-1 truncate font-semibold text-header">{title}</h1>
	{@render children?.()}
	{#if session.isAdmin}
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<a
						{...props}
						href="/settings/catalog"
						aria-label="Catalog settings"
						class="flex size-9 shrink-0 items-center justify-center rounded text-interactive hover:text-normal"
					>
						<Settings class="size-5" />
					</a>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content side="bottom">Catalog settings</Tooltip.Content>
		</Tooltip.Root>
	{/if}
</header>
