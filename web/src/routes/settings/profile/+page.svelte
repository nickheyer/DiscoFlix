<script lang="ts">
	import { identityClient } from '#lib/api/clients';
	import { errorText } from '#lib/api/errors';
	import { session } from '#lib/identity/session.svelte';
	import UserAvatar from '#lib/identity/UserAvatar.svelte';
	import { formatShort, toDate } from '#lib/theme/format';
	import { Button } from '#lib/ui/button';
	import { Input } from '#lib/ui/input';
	import { Label } from '#lib/ui/label';
	import SettingsSection from '#lib/ui/SettingsSection.svelte';

	const user = $derived(session.user);
	const identities = $derived(session.me?.identities ?? []);
	const username = $derived(identities.find((i) => i.provider === 'local')?.subject ?? '');

	let displayName = $state(session.user?.displayName ?? '');
	let nameBusy = $state(false);
	let nameMessage = $state<{ ok: boolean; text: string } | null>(null);

	let current = $state('');
	let next = $state('');
	let confirm = $state('');
	let passwordBusy = $state(false);
	let passwordMessage = $state<{ ok: boolean; text: string } | null>(null);
	const passwordValid = $derived(current.length > 0 && next.length >= 12 && next === confirm);

	async function saveName(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		if (!user) return;
		nameBusy = true;
		nameMessage = null;
		try {
			await identityClient.updateUser({
				id: user.id,
				displayName: displayName.trim(),
				status: user.status,
				systemAdmin: user.systemAdmin
			});
			await session.refreshMe();
			nameMessage = { ok: true, text: 'Display name saved' };
		} catch (err) {
			nameMessage = { ok: false, text: errorText(err) };
		} finally {
			nameBusy = false;
		}
	}

	async function changePassword(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		passwordBusy = true;
		passwordMessage = null;
		try {
			await identityClient.changePassword({ currentPassword: current, newPassword: next });
			current = next = confirm = '';
			passwordMessage = { ok: true, text: 'Password changed' };
		} catch (err) {
			passwordMessage = { ok: false, text: errorText(err) };
		} finally {
			passwordBusy = false;
		}
	}
</script>

{#if user}
	<div class="mb-6 flex items-center gap-4 rounded-lg bg-tertiary p-4">
		<UserAvatar id={user.id} name={user.displayName} src={user.avatarUrl} accent={user.accentColor} size={80} />
		<div class="min-w-0">
			<p class="truncate text-xl font-semibold text-header">{user.displayName}</p>
			{#if username}
				<p class="truncate text-sm text-interactive">{username}</p>
			{/if}
			{#if user.systemAdmin}
				<span class="mt-1 inline-block rounded bg-blurple px-1.5 text-xs font-semibold text-white">Administrator</span>
			{/if}
		</div>
	</div>

	<SettingsSection
		title="Display name"
		description={session.isAdmin
			? 'Shown on every message you send'
			: 'Ask an administrator to change your display name'}
	>
		{#if session.isAdmin}
			<form class="flex flex-col gap-2 sm:flex-row" onsubmit={saveName}>
				<Label for="display-name" class="sr-only">Display name</Label>
				<Input id="display-name" bind:value={displayName} maxlength={64} required class="h-10 border-0 bg-tertiary" />
				<Button
					type="submit"
					class="h-10"
					disabled={nameBusy || displayName.trim() === '' || displayName.trim() === user.displayName}
				>
					{nameBusy ? 'Saving' : 'Save'}
				</Button>
			</form>
		{:else}
			<p class="rounded bg-tertiary px-3 py-2 text-normal">{user.displayName}</p>
		{/if}
		{#if nameMessage}
			<p class="mt-2 text-sm {nameMessage.ok ? 'text-online' : 'text-dnd'}" role="status">{nameMessage.text}</p>
		{/if}
	</SettingsSection>

	<SettingsSection title="Password" description="Use at least 12 characters">
		<form class="grid max-w-sm gap-3" onsubmit={changePassword}>
			<input class="hidden" autocomplete="username" value={username} readonly />
			<div class="space-y-1.5">
				<Label for="current">Current password</Label>
				<Input
					id="current"
					type="password"
					bind:value={current}
					autocomplete="current-password"
					class="h-10 border-0 bg-tertiary"
				/>
			</div>
			<div class="space-y-1.5">
				<Label for="new">New password</Label>
				<Input
					id="new"
					type="password"
					bind:value={next}
					autocomplete="new-password"
					minlength={12}
					maxlength={256}
					class="h-10 border-0 bg-tertiary"
				/>
			</div>
			<div class="space-y-1.5">
				<Label for="confirm">Confirm new password</Label>
				<Input
					id="confirm"
					type="password"
					bind:value={confirm}
					autocomplete="new-password"
					aria-invalid={confirm !== '' && confirm !== next}
					class="h-10 border-0 bg-tertiary"
				/>
				{#if confirm !== '' && confirm !== next}
					<p class="text-xs text-dnd">Passwords do not match</p>
				{/if}
			</div>
			<Button type="submit" class="h-10 justify-self-start" disabled={!passwordValid || passwordBusy}>
				{passwordBusy ? 'Changing password' : 'Change password'}
			</Button>
			{#if passwordMessage}
				<p class="text-sm {passwordMessage.ok ? 'text-online' : 'text-dnd'}" role="status">{passwordMessage.text}</p>
			{/if}
		</form>
	</SettingsSection>

	<SettingsSection title="Linked identities" description="Every way this account can be recognized">
		{#if identities.length === 0}
			<p class="text-sm text-faint">No identities are linked</p>
		{/if}
		<ul class="divide-y divide-divider rounded-lg bg-sidebar">
			{#each identities as identity (identity.id)}
				<li class="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
					<span class="min-w-0">
						<span class="block font-medium text-header">{identity.provider}</span>
						<span class="block truncate text-sm text-interactive">{identity.display || identity.subject}</span>
					</span>
					<span class="text-xs text-faint">Linked {formatShort(toDate(identity.linkedAt))}</span>
				</li>
			{/each}
		</ul>
	</SettingsSection>
{/if}
