<script lang="ts">
	import { createQueryOptions } from '@connectrpc/connect-query-core';
	import { createQuery } from '@tanstack/svelte-query';
	import { errorText } from '#lib/api/errors';
	import { transport } from '#lib/api/transport';
	import { IdentityService, UserKind, UserStatus, type User } from '#lib/gen/discoflix/identity/v1/identity_pb';
	import { formatAgo, toDate } from '#lib/theme/format';
	import UserAvatar from './UserAvatar.svelte';

	const users = createQuery(() => createQueryOptions(IdentityService.method.listUsers, {}, { transport }));

	const kindLabels: Record<UserKind, string> = {
		[UserKind.UNSPECIFIED]: 'User',
		[UserKind.PERSON]: 'Person',
		[UserKind.BOT]: 'Bot',
		[UserKind.PLUGIN]: 'Plugin',
		[UserKind.AGENT]: 'Agent'
	};

	const groups = $derived.by(() => {
		const all = [...(users.data?.users ?? [])].sort((a, b) => a.displayName.localeCompare(b.displayName));
		const active = all.filter((u) => u.status !== UserStatus.DISABLED);
		const automated = (u: User) => u.kind !== UserKind.PERSON && u.kind !== UserKind.UNSPECIFIED;
		return [
			{ label: 'Administrators', users: active.filter((u) => u.systemAdmin && !automated(u)) },
			{ label: 'Members', users: active.filter((u) => !u.systemAdmin && !automated(u)) },
			{ label: 'Automation', users: active.filter(automated) },
			{ label: 'Disabled', users: all.filter((u) => u.status === UserStatus.DISABLED) }
		].filter((g) => g.users.length > 0);
	});

	function seen(user: User): string {
		const at = toDate(user.lastSeenAt);
		return at ? `Seen ${formatAgo(at)}` : kindLabels[user.kind];
	}
</script>

<section aria-label="Members">
	{#if users.isError}
		<p class="px-4 py-2 text-sm text-dnd">{errorText(users.error)}</p>
		<button class="px-4 text-sm text-link hover:underline" onclick={() => users.refetch()}>Retry</button>
	{:else if users.isPending}
		<div class="space-y-3 px-4 py-2">
			{#each [60, 45, 70] as width (width)}
				<div class="flex items-center gap-3">
					<div class="size-8 animate-pulse rounded-full bg-hovered"></div>
					<div class="h-3 animate-pulse rounded bg-hovered" style:width="{width}%"></div>
				</div>
			{/each}
		</div>
	{/if}
	{#each groups as group (group.label)}
		<h3 class="px-4 pt-5 pb-1 text-xs font-semibold tracking-wide text-faint uppercase">
			{group.label} ({group.users.length})
		</h3>
		<ul>
			{#each group.users as user (user.id)}
				<li
					class="mx-2 flex items-center gap-3 rounded px-2 py-1.5 hover:bg-hovered {user.status === UserStatus.DISABLED
						? 'opacity-40'
						: ''}"
				>
					<UserAvatar id={user.id} name={user.displayName} src={user.avatarUrl} accent={user.accentColor} size={32} />
					<span class="min-w-0">
						<span class="flex items-center gap-1.5">
							<span class="truncate text-[15px] font-medium" style:color={user.accentColor || undefined}
								>{user.displayName}</span
							>
							{#if user.kind !== UserKind.PERSON && user.kind !== UserKind.UNSPECIFIED}
								<span class="rounded bg-blurple px-1 text-[10px] font-semibold text-white uppercase"
									>{kindLabels[user.kind]}</span
								>
							{/if}
						</span>
						<span class="block truncate text-xs text-faint">{seen(user)}</span>
					</span>
				</li>
			{/each}
		</ul>
	{/each}
</section>
