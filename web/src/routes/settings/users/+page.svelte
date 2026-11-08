<script lang="ts">
	import { timestampFromDate } from '@bufbuild/protobuf/wkt';
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
		type User,
		type UserMerge
	} from '#lib/gen/discoflix/identity/v1/identity_pb';
	import { session } from '#lib/identity/session.svelte';
	import UserAvatar from '#lib/identity/UserAvatar.svelte';
	import { formatShort, toDate } from '#lib/theme/format';
	import AdminOnly from '#lib/ui/AdminOnly.svelte';
	import { Button } from '#lib/ui/button';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import CopyButton from '#lib/ui/CopyButton.svelte';
	import * as Dialog from '#lib/ui/dialog';
	import { Input } from '#lib/ui/input';
	import { Label } from '#lib/ui/label';
	import SettingsSection from '#lib/ui/SettingsSection.svelte';
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

	const merges = createQuery(() => ({
		...createQueryOptions(IdentityService.method.listUserMerges, {}, { transport }),
		enabled: session.isAdmin
	}));
	let reverting = $state<UserMerge | null>(null);
	let revertOpen = $state(false);

	let accountName = $state('');
	let accountKind = $state<UserKind>(UserKind.AGENT);
	let accountKey = $state('');
	let accountDays = $state(0);
	let creating = $state(false);
	let createError = $state('');
	let secret = $state<{ name: string; value: string } | null>(null);

	const lifetimes = [
		{ label: 'Key never expires', days: 0 },
		{ label: 'Key expires in 90 days', days: 90 },
		{ label: 'Key expires in 1 year', days: 365 }
	];

	// Creates a bot or agent user whose first API key is shown once
	async function createAccount(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		creating = true;
		createError = '';
		try {
			const expiresAt =
				accountDays > 0 ? timestampFromDate(new Date(Date.now() + accountDays * 86_400_000)) : undefined;
			const res = await identityClient.createServiceAccount({
				displayName: accountName.trim(),
				kind: accountKind,
				keyName: accountKey.trim() || 'default',
				expiresAt
			});
			secret = { name: res.user?.displayName ?? accountName, value: res.secret };
			accountName = '';
			accountKey = '';
			await users.refetch();
		} catch (err) {
			createError = errorText(err);
		} finally {
			creating = false;
		}
	}

	async function revert(): Promise<void> {
		if (!reverting) return;
		await identityClient.revertUserMerge({ id: reverting.id });
		await Promise.all([merges.refetch(), users.refetch()]);
	}

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
		<p class="mb-3 text-sm text-faint">{rows.length} users, people from mirrored Discord servers included</p>
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

	<SettingsSection
		title="Service accounts"
		description="Bots and agents hold an API key, and any destructive call they make waits for an approval card"
	>
		<form class="grid gap-2 sm:grid-cols-2" onsubmit={createAccount}>
			<div class="space-y-1">
				<Label for="account-name" class="text-xs font-bold tracking-wide text-interactive uppercase">Name</Label>
				<Input
					id="account-name"
					bind:value={accountName}
					maxlength={64}
					required
					placeholder="Claude Code"
					class="h-10 border-0 bg-tertiary"
				/>
			</div>
			<div class="space-y-1">
				<Label for="account-kind" class="text-xs font-bold tracking-wide text-interactive uppercase">Kind</Label>
				<select
					id="account-kind"
					bind:value={accountKind}
					class="h-10 w-full rounded-md bg-tertiary px-3 text-sm text-normal outline-none focus:ring-2 focus:ring-ring"
				>
					<option value={UserKind.AGENT}>Agent, an AI or automation acting on its own</option>
					<option value={UserKind.BOT}>Bot, a script that posts and reads</option>
				</select>
			</div>
			<div class="space-y-1">
				<Label for="account-key" class="text-xs font-bold tracking-wide text-interactive uppercase">Key name</Label>
				<Input
					id="account-key"
					bind:value={accountKey}
					maxlength={64}
					placeholder="default"
					class="h-10 border-0 bg-tertiary"
				/>
			</div>
			<div class="space-y-1">
				<Label for="account-lifetime" class="text-xs font-bold tracking-wide text-interactive uppercase">Lifetime</Label
				>
				<select
					id="account-lifetime"
					bind:value={accountDays}
					class="h-10 w-full rounded-md bg-tertiary px-3 text-sm text-normal outline-none focus:ring-2 focus:ring-ring"
				>
					{#each lifetimes as lifetime (lifetime.days)}
						<option value={lifetime.days}>{lifetime.label}</option>
					{/each}
				</select>
			</div>
			<div class="sm:col-span-2">
				<Button type="submit" disabled={creating || accountName.trim() === ''}>
					{creating ? 'Creating' : 'Create service account'}
				</Button>
			</div>
		</form>
		{#if createError}
			<p class="mt-2 text-sm text-dnd" role="alert">{createError}</p>
		{/if}
	</SettingsSection>

	<SettingsSection
		title="Merged accounts"
		description="Identity linking folded one user into another, each merge can be undone"
	>
		{#if merges.isError}
			<p class="text-sm text-dnd" role="alert">{errorText(merges.error)}</p>
		{:else if merges.isPending}
			<p class="text-sm text-faint" role="status">Loading merges</p>
		{:else if merges.data.merges.length === 0}
			<p class="text-sm text-faint">No accounts have been merged</p>
		{:else}
			<ul class="divide-y divide-divider rounded-lg bg-sidebar">
				{#each merges.data.merges as merge (merge.id)}
					<li class="flex flex-wrap items-center gap-3 px-4 py-3">
						<span class="min-w-0 flex-1">
							<span class="block truncate text-sm">
								<strong class="text-header">{merge.fromUser?.displayName}</strong>
								<span class="text-interactive"> merged into </span>
								<strong class="text-header">{merge.intoUser?.displayName}</strong>
							</span>
							<span class="block text-xs text-faint">
								{formatShort(toDate(merge.createdAt))}{merge.revertedAt
									? `, reverted ${formatShort(toDate(merge.revertedAt))}`
									: ''}
							</span>
						</span>
						{#if !merge.revertedAt}
							<Button
								variant="secondary"
								size="sm"
								onclick={() => {
									reverting = merge;
									revertOpen = true;
								}}>Revert</Button
							>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</SettingsSection>
</AdminOnly>

<Dialog.Root
	open={secret !== null}
	onOpenChange={(open) => {
		if (!open) secret = null;
	}}
>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>API key for {secret?.name}</Dialog.Title>
			<Dialog.Description>Copy the key now. It is shown only once and cannot be recovered.</Dialog.Description>
		</Dialog.Header>
		{#if secret}
			<Label for="account-secret" class="sr-only">API key</Label>
			<input
				id="account-secret"
				readonly
				value={secret.value}
				class="w-full rounded bg-tertiary px-3 py-2 font-mono text-sm text-header outline-none"
				onfocus={(e) => e.currentTarget.select()}
			/>
			<Dialog.Footer>
				<CopyButton value={secret.value} label="Copy key" />
				<Button onclick={() => (secret = null)}>Done</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog bind:open={revertOpen} title="Revert merge" confirmLabel="Revert" onconfirm={revert}>
	<strong>{reverting?.fromUser?.displayName}</strong> gets its own identities and sign-in back, and
	<strong>{reverting?.intoUser?.displayName}</strong> loses the memberships the merge added. Both are signed out.
</ConfirmDialog>

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
