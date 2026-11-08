<script lang="ts">
	import { timestampFromDate } from '@bufbuild/protobuf/wkt';
	import { createQueryOptions } from '@connectrpc/connect-query-core';
	import { createQuery } from '@tanstack/svelte-query';
	import { identityClient } from '#lib/api/clients';
	import { errorText } from '#lib/api/errors';
	import { transport } from '#lib/api/transport';
	import { IdentityService, type ApiKey } from '#lib/gen/discoflix/identity/v1/identity_pb';
	import { formatShort, toDate } from '#lib/theme/format';
	import { Button } from '#lib/ui/button';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import CopyButton from '#lib/ui/CopyButton.svelte';
	import * as Dialog from '#lib/ui/dialog';
	import { Input } from '#lib/ui/input';
	import { Label } from '#lib/ui/label';
	import SettingsSection from '#lib/ui/SettingsSection.svelte';

	const keys = createQuery(() => createQueryOptions(IdentityService.method.listApiKeys, {}, { transport }));

	const lifetimes = [
		{ label: 'Never expires', days: 0 },
		{ label: '30 days', days: 30 },
		{ label: '90 days', days: 90 },
		{ label: '1 year', days: 365 }
	];

	let name = $state('');
	let days = $state(90);
	let creating = $state(false);
	let createError = $state('');
	let secret = $state<{ name: string; value: string } | null>(null);
	let revoking = $state<ApiKey | null>(null);
	let confirmOpen = $state(false);

	async function create(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		creating = true;
		createError = '';
		try {
			const expiresAt = days > 0 ? timestampFromDate(new Date(Date.now() + days * 86_400_000)) : undefined;
			const res = await identityClient.createApiKey({ name: name.trim(), expiresAt });
			secret = { name: res.apiKey?.name ?? name.trim(), value: res.secret };
			name = '';
			await keys.refetch();
		} catch (err) {
			createError = errorText(err);
		} finally {
			creating = false;
		}
	}

	async function revoke(): Promise<void> {
		if (!revoking) return;
		await identityClient.revokeApiKey({ id: revoking.id });
		await keys.refetch();
	}

	function expiry(key: ApiKey): string {
		const at = toDate(key.expiresAt);
		if (!at) return 'never expires';
		return at.getTime() < Date.now() ? `expired ${formatShort(at)}` : `expires ${formatShort(at)}`;
	}
</script>

<SettingsSection title="Create an API key" description="Keys act as you for scripts, plugins, and MCP clients">
	<form class="grid gap-2 sm:grid-cols-[1fr_auto_auto]" onsubmit={create}>
		<Label for="key-name" class="sr-only">Key name</Label>
		<Input
			id="key-name"
			bind:value={name}
			placeholder="Name, such as Home Assistant"
			maxlength={64}
			required
			class="h-10 border-0 bg-tertiary"
		/>
		<Label for="key-lifetime" class="sr-only">Lifetime</Label>
		<select
			id="key-lifetime"
			bind:value={days}
			class="h-10 rounded-md bg-tertiary px-3 text-sm text-normal outline-none focus:ring-2 focus:ring-ring"
		>
			{#each lifetimes as lifetime (lifetime.days)}
				<option value={lifetime.days}>{lifetime.label}</option>
			{/each}
		</select>
		<Button type="submit" class="h-10" disabled={creating || name.trim() === ''}>
			{creating ? 'Creating' : 'Create key'}
		</Button>
	</form>
	{#if createError}
		<p class="mt-2 text-sm text-dnd" role="alert">{createError}</p>
	{/if}
</SettingsSection>

<SettingsSection title="Your API keys">
	{#if keys.isError}
		<p class="text-sm text-dnd" role="alert">{errorText(keys.error)}</p>
	{:else if keys.isPending}
		<p class="text-sm text-faint" role="status">Loading API keys</p>
	{:else if keys.data.apiKeys.length === 0}
		<p class="text-sm text-faint">No API keys yet</p>
	{:else}
		<ul class="divide-y divide-divider rounded-lg bg-sidebar">
			{#each keys.data.apiKeys as key (key.id)}
				<li class="flex flex-wrap items-center gap-3 px-4 py-3">
					<span class="min-w-0 flex-1">
						<span class="flex items-center gap-2">
							<span class="truncate font-medium text-header">{key.name}</span>
							<code class="rounded bg-tertiary px-1.5 font-mono text-xs text-interactive">{key.prefix}</code>
						</span>
						<span class="block text-xs text-faint">
							Created {formatShort(toDate(key.createdAt))}, last used {formatShort(toDate(key.lastUsedAt))}, {expiry(
								key
							)}
						</span>
					</span>
					<Button
						variant="destructive"
						size="sm"
						onclick={() => {
							revoking = key;
							confirmOpen = true;
						}}>Revoke</Button
					>
				</li>
			{/each}
		</ul>
	{/if}
</SettingsSection>

<Dialog.Root
	open={secret !== null}
	onOpenChange={(open) => {
		if (!open) secret = null;
	}}
>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>API key {secret?.name} created</Dialog.Title>
			<Dialog.Description>Copy the key now. It is shown only once and cannot be recovered.</Dialog.Description>
		</Dialog.Header>
		{#if secret}
			<Label for="secret" class="sr-only">API key</Label>
			<input
				id="secret"
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

<ConfirmDialog bind:open={confirmOpen} title="Revoke API key" confirmLabel="Revoke" onconfirm={revoke}>
	Anything using <strong>{revoking?.name}</strong> will stop working immediately.
</ConfirmDialog>
