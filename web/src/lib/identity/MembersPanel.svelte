<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { errorText } from '#lib/api/errors';
	import type { Member, Role } from '#lib/gen/discoflix/timeline/v1/timeline_pb';
	import { membersQuery } from '#lib/spaces/queries';
	import { timeline } from '#lib/timeline/store.svelte';
	import UserAvatar, { type Presence } from './UserAvatar.svelte';

	let { spaceId }: { spaceId: string } = $props();

	const members = createQuery(() => ({ ...membersQuery(spaceId), enabled: spaceId !== '' }));

	function presenceOf(member: Member): Presence {
		const live = timeline.presenceOf(member.user?.id ?? '') || member.presence;
		return live === 'online' || live === 'idle' || live === 'dnd' ? live : 'offline';
	}

	// Picks the highest hoisted role of a member, which is the group Discord shows them under
	function hoisted(member: Member, roles: Role[]): Role | undefined {
		return roles.filter((r) => r.hoist && member.roles.includes(r.id)).sort((a, b) => b.position - a.position)[0];
	}

	function colorOf(member: Member, roles: Role[]): string | undefined {
		const colored = roles
			.filter((r) => r.color && member.roles.includes(r.id))
			.sort((a, b) => b.position - a.position)[0];
		return colored?.color || member.user?.accentColor || undefined;
	}

	const groups = $derived.by(() => {
		const roles = members.data?.roles ?? [];
		const all = members.data?.members ?? [];
		const byName = (a: Member, b: Member) =>
			(a.nickname || a.user?.displayName || '').localeCompare(b.nickname || b.user?.displayName || '');
		const online = all.filter((m) => presenceOf(m) !== 'offline');
		const offline = all.filter((m) => presenceOf(m) === 'offline').sort(byName);
		const grouped = new Map<string, { label: string; position: number; members: Member[] }>();
		for (const m of online) {
			const role = hoisted(m, roles);
			const key = role?.id ?? (m.admin ? 'admins' : 'online');
			const label = role?.name ?? (m.admin ? 'Administrators' : 'Online');
			const position = role ? role.position + 1000 : m.admin ? 500 : 0;
			const group = grouped.get(key) ?? { label, position, members: [] };
			group.members.push(m);
			grouped.set(key, group);
		}
		const out = [...grouped.values()].sort((a, b) => b.position - a.position);
		for (const g of out) g.members.sort(byName);
		if (offline.length) out.push({ label: 'Offline', position: -1, members: offline });
		return { out, roles };
	});
</script>

<section aria-label="Members">
	{#if members.isError}
		<p class="px-4 py-2 text-sm text-dnd">{errorText(members.error)}</p>
		<button class="px-4 text-sm text-link hover:underline" onclick={() => members.refetch()}>Retry</button>
	{:else if members.isPending}
		<div class="space-y-3 px-4 py-2">
			{#each [60, 45, 70] as width (width)}
				<div class="flex items-center gap-3">
					<div class="size-8 animate-pulse rounded-full bg-hovered"></div>
					<div class="h-3 animate-pulse rounded bg-hovered" style:width="{width}%"></div>
				</div>
			{/each}
		</div>
	{/if}
	{#each groups.out as group (group.label)}
		<h3 class="px-4 pt-5 pb-1 text-xs font-semibold tracking-wide text-faint uppercase">
			{group.label} ({group.members.length})
		</h3>
		<ul>
			{#each group.members as member (member.user?.id)}
				{@const user = member.user}
				{@const presence = presenceOf(member)}
				<li
					class="mx-2 flex items-center gap-3 rounded px-2 py-1.5 hover:bg-hovered {presence === 'offline'
						? 'opacity-40 hover:opacity-100'
						: ''}"
				>
					<UserAvatar
						id={user?.id ?? ''}
						name={user?.displayName ?? '?'}
						src={user?.avatarUrl}
						accent={user?.accentColor}
						size={32}
						{presence}
					/>
					<span class="min-w-0">
						<span class="flex items-center gap-1.5">
							<span class="truncate text-[15px] font-medium" style:color={colorOf(member, groups.roles)}
								>{member.nickname || user?.displayName}</span
							>
							{#if user && user.kind !== 'person' && user.kind !== ''}
								<span class="rounded bg-blurple px-1 text-[10px] font-semibold text-white uppercase">{user.kind}</span>
							{/if}
						</span>
						{#if member.nickname && user && member.nickname !== user.displayName}
							<span class="block truncate text-xs text-faint">{user.displayName}</span>
						{/if}
					</span>
				</li>
			{/each}
		</ul>
	{/each}
</section>
