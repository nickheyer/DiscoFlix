<script lang="ts">
	import { createConnectQueryKey, createQueryOptions } from '@connectrpc/connect-query-core';
	import Check from '@lucide/svelte/icons/check';
	import Pencil from '@lucide/svelte/icons/pencil';
	import X from '@lucide/svelte/icons/x';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { SvelteMap } from 'svelte/reactivity';
	import { identityClient } from '#lib/api/clients';
	import { errorText } from '#lib/api/errors';
	import { transport } from '#lib/api/transport';
	import {
		IdentityService,
		UserKind,
		UserStatus,
		type ListUsersResponse,
		type User
	} from '#lib/gen/discoflix/identity/v1/identity_pb';
	import { session } from '#lib/identity/session.svelte';
	import UserAvatar from '#lib/identity/UserAvatar.svelte';
	import { formatShort, toDate } from '#lib/theme/format';
	import AdminOnly from '#lib/ui/AdminOnly.svelte';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import { Input } from '#lib/ui/input';
	import { Switch } from '#lib/ui/switch';
	import { createVirtualList } from '#lib/ui/virtual/list.svelte';

	type Change = Partial<Pick<User, 'displayName' | 'status' | 'systemAdmin'>>;

	const client = useQueryClient();
	const users = createQuery(() => ({
		...createQueryOptions(IdentityService.method.listUsers, {}, { transport }),
		enabled: session.isAdmin
	}));
	const rows = $derived([...(users.data?.users ?? [])].sort((a, b) => a.displayName.localeCompare(b.displayName)));

	let scroller = $state<HTMLDivElement>();
	const list = createVirtualList({
		count: () => rows.length,
		scrollElement: () => scroller,
		estimateSize: () => 72,
		itemKey: (i) => rows[i]?.id ?? i
	});

	const pending = new SvelteMap<string, boolean>();
	const errors = new SvelteMap<string, string>();
	let editingId = $state<string | null>(null);
	let draftName = $state('');
	let selfChange = $state<{ user: User; change: Change; text: string } | null>(null);
	let confirmOpen = $state(false);

	const kinds: Record<UserKind, string> = {
		[UserKind.UNSPECIFIED]: 'User',
		[UserKind.PERSON]: 'Person',
		[UserKind.BOT]: 'Bot',
		[UserKind.PLUGIN]: 'Plugin',
		[UserKind.AGENT]: 'Agent'
	};

	// Sends every field so implicit proto3 defaults never clear an unchanged value
	async function update(user: User, change: Change): Promise<void> {
		pending.set(user.id, true);
		errors.delete(user.id);
		try {
			const res = await identityClient.updateUser({
				id: user.id,
				displayName: change.displayName ?? user.displayName,
				status: change.status ?? user.status,
				systemAdmin: change.systemAdmin ?? user.systemAdmin
			});
			const updated = res.user;
			if (updated) {
				const key = createConnectQueryKey({
					schema: IdentityService.method.listUsers,
					input: {},
					transport,
					cardinality: 'finite'
				});
				client.setQueryData(key, (old: ListUsersResponse | undefined) =>
					old ? { ...old, users: old.users.map((u) => (u.id === updated.id ? updated : u)) } : old
				);
			}
			if (user.id === session.user?.id) await session.refreshMe();
		} catch (err) {
			errors.set(user.id, errorText(err));
			throw err;
		} finally {
			pending.delete(user.id);
		}
	}

	function request(user: User, change: Change): void {
		const self = user.id === session.user?.id;
		if (self && change.status === UserStatus.DISABLED) {
			selfChange = { user, change, text: 'Disabling your own account signs you out everywhere.' };
		} else if (self && change.systemAdmin === false) {
			selfChange = { user, change, text: 'You will lose access to administration pages.' };
		} else {
			void update(user, change).catch(() => undefined);
			return;
		}
		confirmOpen = true;
	}

	async function saveName(user: User): Promise<void> {
		const name = draftName.trim();
		if (name === '' || name === user.displayName) {
			editingId = null;
			return;
		}
		try {
			await update(user, { displayName: name });
			editingId = null;
		} catch {
			return;
		}
	}
</script>

<AdminOnly>
	{#if users.isError}
		<p class="text-sm text-dnd" role="alert">{errorText(users.error)}</p>
	{:else if users.isPending}
		<p class="text-sm text-faint" role="status">Loading users</p>
	{:else}
		<p class="mb-3 text-sm text-faint">{rows.length} users</p>
		<div bind:this={scroller} class="max-h-[70vh] overflow-y-auto rounded-lg bg-sidebar scroll-thin">
			<ul class="relative w-full" style:height="{list.size}px">
				{#each list.items as item (item.key)}
					{@const user = rows[item.index]}
					{#if user}
						<li
							data-index={item.index}
							{@attach list.measure}
							class="absolute inset-x-0 top-0 flex flex-wrap items-center gap-3 border-b border-divider px-4 py-3"
							style:transform="translateY({item.start}px)"
						>
							<UserAvatar
								id={user.id}
								name={user.displayName}
								src={user.avatarUrl}
								accent={user.accentColor}
								size={36}
							/>
							<div class="min-w-0 flex-1 basis-48">
								{#if editingId === user.id}
									<form
										class="flex items-center gap-1"
										onsubmit={(e) => {
											e.preventDefault();
											void saveName(user);
										}}
									>
										<Input
											bind:value={draftName}
											maxlength={64}
											aria-label="Display name for {user.displayName}"
											class="h-8 border-0 bg-tertiary"
										/>
										<button type="submit" aria-label="Save name" class="p-1 text-online hover:text-header">
											<Check class="size-4" />
										</button>
										<button
											type="button"
											aria-label="Cancel"
											class="p-1 text-faint hover:text-header"
											onclick={() => (editingId = null)}
										>
											<X class="size-4" />
										</button>
									</form>
								{:else}
									<span class="flex items-center gap-1.5">
										<span class="truncate font-medium text-header">{user.displayName}</span>
										<button
											aria-label="Edit display name of {user.displayName}"
											class="p-0.5 text-faint hover:text-normal"
											onclick={() => {
												editingId = user.id;
												draftName = user.displayName;
											}}
										>
											<Pencil class="size-3.5" />
										</button>
									</span>
								{/if}
								<span class="block truncate text-xs text-faint">
									{kinds[user.kind]}, joined {formatShort(toDate(user.createdAt))}, seen {formatShort(
										toDate(user.lastSeenAt)
									)}
								</span>
								{#if errors.get(user.id)}
									<span class="block text-xs text-dnd" role="alert">{errors.get(user.id)}</span>
								{/if}
							</div>
							<label class="flex items-center gap-2 text-sm text-interactive">
								<Switch
									bind:checked={
										() => user.status !== UserStatus.DISABLED,
										(on) => request(user, { status: on ? UserStatus.ACTIVE : UserStatus.DISABLED })
									}
									disabled={pending.get(user.id)}
								/>
								Active
							</label>
							<label class="flex items-center gap-2 text-sm text-interactive">
								<Switch
									bind:checked={() => user.systemAdmin, (on) => request(user, { systemAdmin: on })}
									disabled={pending.get(user.id)}
								/>
								Admin
							</label>
						</li>
					{/if}
				{/each}
			</ul>
		</div>
	{/if}
</AdminOnly>

<ConfirmDialog
	bind:open={confirmOpen}
	title="Change your own account"
	confirmLabel="Continue"
	onconfirm={async () => {
		if (selfChange) await update(selfChange.user, selfChange.change);
	}}
>
	{selfChange?.text}
</ConfirmDialog>
