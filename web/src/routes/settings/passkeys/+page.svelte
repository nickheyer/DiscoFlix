<script lang="ts">
	import { createQueryOptions } from '@connectrpc/connect-query-core';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import { createQuery } from '@tanstack/svelte-query';
	import { identityClient } from '#lib/api/clients';
	import { errorText } from '#lib/api/errors';
	import { transport } from '#lib/api/transport';
	import { IdentityService, type Passkey } from '#lib/gen/discoflix/identity/v1/identity_pb';
	import { createPasskey, passkeysSupported } from '#lib/identity/webauthn';
	import { formatShort, toDate } from '#lib/theme/format';
	import { Button } from '#lib/ui/button';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import { Input } from '#lib/ui/input';
	import { Label } from '#lib/ui/label';
	import SettingsSection from '#lib/ui/SettingsSection.svelte';

	const passkeys = createQuery(() => createQueryOptions(IdentityService.method.listPasskeys, {}, { transport }));
	const supported = passkeysSupported();

	let name = $state('');
	let adding = $state(false);
	let addMessage = $state<{ ok: boolean; text: string } | null>(null);
	let removing = $state<Passkey | null>(null);
	let confirmOpen = $state(false);

	async function add(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		adding = true;
		addMessage = null;
		try {
			const begin = await identityClient.beginPasskeyRegistration({});
			const credentialJson = await createPasskey(begin.optionsJson);
			const res = await identityClient.finishPasskeyRegistration({ name: name.trim(), credentialJson });
			addMessage = { ok: true, text: `Passkey ${res.passkey?.name ?? name.trim()} added` };
			name = '';
			await passkeys.refetch();
		} catch (err) {
			addMessage = {
				ok: false,
				text:
					err instanceof DOMException && err.name === 'NotAllowedError'
						? 'Passkey creation was cancelled'
						: errorText(err)
			};
		} finally {
			adding = false;
		}
	}

	async function remove(): Promise<void> {
		if (!removing) return;
		await identityClient.deletePasskey({ id: removing.id });
		await passkeys.refetch();
	}
</script>

<SettingsSection title="Add a passkey" description="Sign in with your device unlock instead of a password">
	{#if supported}
		<form class="flex flex-col gap-2 sm:flex-row" onsubmit={add}>
			<Label for="passkey-name" class="sr-only">Passkey name</Label>
			<Input
				id="passkey-name"
				bind:value={name}
				placeholder="Name, such as Work laptop"
				maxlength={64}
				required
				class="h-10 border-0 bg-tertiary"
			/>
			<Button type="submit" class="h-10" disabled={adding || name.trim() === ''}>
				<KeyRound class="size-4" />
				{adding ? 'Waiting for device' : 'Add passkey'}
			</Button>
		</form>
	{:else}
		<p class="rounded bg-idle/15 p-3 text-sm text-idle" role="alert">This browser cannot create passkeys</p>
	{/if}
	{#if addMessage}
		<p class="mt-2 text-sm {addMessage.ok ? 'text-online' : 'text-dnd'}" role="status">{addMessage.text}</p>
	{/if}
</SettingsSection>

<SettingsSection title="Your passkeys">
	{#if passkeys.isError}
		<p class="text-sm text-dnd" role="alert">{errorText(passkeys.error)}</p>
	{:else if passkeys.isPending}
		<p class="text-sm text-faint" role="status">Loading passkeys</p>
	{:else if passkeys.data.passkeys.length === 0}
		<p class="text-sm text-faint">No passkeys yet</p>
	{:else}
		<ul class="divide-y divide-divider rounded-lg bg-sidebar">
			{#each passkeys.data.passkeys as passkey (passkey.id)}
				<li class="flex flex-wrap items-center gap-3 px-4 py-3">
					<KeyRound class="size-5 text-interactive" />
					<span class="min-w-0 flex-1">
						<span class="flex items-center gap-2">
							<span class="truncate font-medium text-header">{passkey.name}</span>
							{#if passkey.backupEligible}
								<span class="rounded bg-online/20 px-1.5 text-[11px] font-semibold text-online">Synced</span>
							{/if}
						</span>
						<span class="block text-xs text-faint">
							Added {formatShort(toDate(passkey.createdAt))}, last used {formatShort(toDate(passkey.lastUsedAt))}
						</span>
					</span>
					<Button
						variant="destructive"
						size="sm"
						onclick={() => {
							removing = passkey;
							confirmOpen = true;
						}}>Delete</Button
					>
				</li>
			{/each}
		</ul>
	{/if}
</SettingsSection>

<ConfirmDialog bind:open={confirmOpen} title="Delete passkey" confirmLabel="Delete" onconfirm={remove}>
	The passkey <strong>{removing?.name}</strong> will no longer sign you in.
</ConfirmDialog>
