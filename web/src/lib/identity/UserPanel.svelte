<script lang="ts">
	import Settings from '@lucide/svelte/icons/settings';
	import { realtime } from '#lib/timeline/realtime.svelte';
	import * as Tooltip from '#lib/ui/tooltip';
	import { session } from './session.svelte';
	import UserAvatar, { type Presence } from './UserAvatar.svelte';

	const presence = $derived<Presence>(
		realtime.state === 'connected' ? 'online' : realtime.state === 'connecting' ? 'idle' : 'dnd'
	);
	const label = $derived(
		realtime.state === 'connected' ? 'Live' : realtime.state === 'connecting' ? 'Connecting' : 'Offline'
	);
</script>

{#if session.user}
	<section aria-label="Your account" class="flex h-[52px] shrink-0 items-center gap-2 bg-panel px-2">
		<UserAvatar
			id={session.user.id}
			name={session.user.displayName}
			src={session.user.avatarUrl}
			accent={session.user.accentColor}
			size={32}
			{presence}
			ring="border-panel"
		/>
		<div class="min-w-0 flex-1 leading-tight">
			<p class="truncate text-sm font-semibold text-header">{session.user.displayName}</p>
			<p class="truncate text-xs text-interactive" title={realtime.error || label}>{label}</p>
		</div>
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<a
						{...props}
						href="/settings/profile"
						aria-label="User settings"
						class="flex size-8 items-center justify-center rounded text-interactive hover:bg-hovered hover:text-normal"
					>
						<Settings class="size-5" />
					</a>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content>User settings</Tooltip.Content>
		</Tooltip.Root>
	</section>
{/if}
