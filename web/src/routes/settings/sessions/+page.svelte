<script lang="ts">
	import { createQueryOptions } from '@connectrpc/connect-query-core';
	import Monitor from '@lucide/svelte/icons/monitor';
	import Smartphone from '@lucide/svelte/icons/smartphone';
	import { createQuery } from '@tanstack/svelte-query';
	import { identityClient } from '#lib/api/clients';
	import { errorText } from '#lib/api/errors';
	import { transport } from '#lib/api/transport';
	import { IdentityService, type Session } from '#lib/gen/discoflix/identity/v1/identity_pb';
	import { session as auth } from '#lib/identity/session.svelte';
	import { describeAgent } from '#lib/identity/user-agent';
	import { formatShort, toDate } from '#lib/theme/format';
	import { Button } from '#lib/ui/button';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import SettingsSection from '#lib/ui/SettingsSection.svelte';

	const sessions = createQuery(() => createQueryOptions(IdentityService.method.listSessions, {}, { transport }));
	const sorted = $derived([...(sessions.data?.sessions ?? [])].sort((a, b) => Number(b.current) - Number(a.current)));

	let revoking = $state<Session | null>(null);
	let confirmOpen = $state(false);

	async function revoke(): Promise<void> {
		if (!revoking) return;
		const current = revoking.current;
		await identityClient.revokeSession({ id: revoking.id });
		if (current) await auth.verify();
		else await sessions.refetch();
	}
</script>

<SettingsSection title="Signed-in devices" description="Revoke any session you do not recognize">
	{#if sessions.isError}
		<p class="text-sm text-dnd" role="alert">{errorText(sessions.error)}</p>
	{:else if sessions.isPending}
		<p class="text-sm text-faint" role="status">Loading sessions</p>
	{:else}
		<ul class="divide-y divide-divider rounded-lg bg-sidebar">
			{#each sorted as s (s.id)}
				{@const agent = describeAgent(s.userAgent)}
				{@const Icon = agent.mobile ? Smartphone : Monitor}
				<li class="flex flex-wrap items-center gap-3 px-4 py-3">
					<Icon class="size-6 text-interactive" />
					<span class="min-w-0 flex-1">
						<span class="flex items-center gap-2">
							<span class="truncate font-medium text-header" title={s.userAgent}>{agent.label}</span>
							{#if s.current}
								<span class="rounded bg-online/20 px-1.5 text-[11px] font-semibold text-online">This device</span>
							{/if}
						</span>
						<span class="block text-xs text-faint">
							{s.remoteAddr || 'Unknown address'}, signed in {formatShort(toDate(s.createdAt))}, expires {formatShort(
								toDate(s.expiresAt)
							)}
						</span>
					</span>
					<Button
						variant="destructive"
						size="sm"
						onclick={() => {
							revoking = s;
							confirmOpen = true;
						}}>{s.current ? 'Sign out' : 'Revoke'}</Button
					>
				</li>
			{/each}
		</ul>
	{/if}
</SettingsSection>

<ConfirmDialog
	bind:open={confirmOpen}
	title={revoking?.current ? 'Sign out this device' : 'Revoke session'}
	confirmLabel={revoking?.current ? 'Sign out' : 'Revoke'}
	onconfirm={revoke}
>
	{revoking?.current
		? 'You will be signed out of this browser.'
		: `The session from ${revoking ? describeAgent(revoking.userAgent).label : ''} will be signed out.`}
</ConfirmDialog>
