<script lang="ts">
	import { page } from '$app/state';
	import { identityClient } from '#lib/api/clients';
	import { errorText } from '#lib/api/errors';
	import type { Identity } from '#lib/gen/discoflix/identity/v1/identity_pb';
	import { session } from '#lib/identity/session.svelte';
	import { formatShort, toDate } from '#lib/theme/format';
	import { Button } from '#lib/ui/button';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import SettingsSection from '#lib/ui/SettingsSection.svelte';

	const identities = $derived(session.me?.identities ?? []);
	const discordEnabled = $derived(session.info?.discordLogin ?? false);
	const hasDiscord = $derived(identities.some((i) => i.provider === 'discord'));

	const providerNames: Record<string, string> = {
		local: 'Username and password',
		discord: 'Discord',
		plex: 'Plex',
		jellyfin: 'Jellyfin',
		emby: 'Emby',
		email: 'Email'
	};

	const errors: Record<string, string> = {
		discord_link:
			'Discord did not let that account link, it may already belong to a different user who signed in with it',
		discord_state: 'The linking attempt expired, start again',
		discord_exchange: 'Discord did not accept the request, check the redirect URL in the developer portal',
		discord_profile: 'Discord did not return the account profile',
		signed_out: 'You were signed out before Discord answered'
	};
	const flash = $derived(
		page.url.searchParams.get('linked') === '1'
			? { tone: 'text-online', text: 'Discord account linked' }
			: errors[page.url.searchParams.get('error') ?? '']
				? { tone: 'text-dnd', text: errors[page.url.searchParams.get('error') ?? ''] }
				: null
	);

	let unlinking = $state<Identity | null>(null);
	let confirmOpen = $state(false);

	async function unlink(): Promise<void> {
		if (!unlinking) return;
		await identityClient.unlinkIdentity({ id: unlinking.id });
		await session.refreshMe();
	}

	function label(identity: Identity): string {
		return providerNames[identity.provider] ?? identity.provider;
	}
</script>

<SettingsSection title="Linked accounts" description="Every way of proving you are you, all landing on this one user">
	{#if flash}
		<p class="mb-3 text-sm {flash.tone}" role="status">{flash.text}</p>
	{/if}
	<ul class="divide-y divide-divider rounded-lg bg-sidebar">
		{#each identities as identity (identity.id)}
			<li class="flex flex-wrap items-center gap-3 px-4 py-3">
				<span class="min-w-0 flex-1">
					<span class="flex items-center gap-2">
						<span class="font-medium text-header">{label(identity)}</span>
						<span class="truncate text-sm text-interactive">{identity.display || identity.subject}</span>
					</span>
					<span class="block text-xs text-faint">
						Linked {formatShort(toDate(identity.linkedAt))}, {identity.verifiedAt
							? `verified ${formatShort(toDate(identity.verifiedAt))}`
							: 'seen in a mirrored server, unverified until that account signs in here'}
					</span>
				</span>
				<Button
					variant="destructive"
					size="sm"
					disabled={identities.length <= 1}
					onclick={() => {
						unlinking = identity;
						confirmOpen = true;
					}}>Unlink</Button
				>
			</li>
		{/each}
	</ul>
	{#if identities.length <= 1}
		<p class="mt-2 text-xs text-faint">The last linked account stays, otherwise nothing could sign in as you.</p>
	{/if}
</SettingsSection>

<SettingsSection title="Discord" description="Link the Discord account you use in mirrored servers">
	{#if hasDiscord}
		<p class="text-sm text-interactive">
			Your Discord account is linked. Messages you write in Discord appear here under your name.
		</p>
	{:else if discordEnabled}
		<Button
			href="/auth/discord/start?link=1&next=%2Fsettings%2Fconnections%3Flinked%3D1"
			class="bg-[#5865f2] text-white hover:bg-[#4752c4]"
		>
			Connect Discord
		</Button>
		<p class="mt-2 text-xs text-faint">
			You can also run <code class="rounded bg-tertiary px-1 font-mono">/link</code> in Discord and open the link it gives
			you while signed in here.
		</p>
	{:else}
		<p class="text-sm text-interactive">
			Linking through the browser needs the server's Discord client secret. Until an administrator sets it, run
			<code class="rounded bg-tertiary px-1 font-mono">/link</code> in Discord and open the link it gives you while signed
			in here.
		</p>
	{/if}
</SettingsSection>

<ConfirmDialog bind:open={confirmOpen} title="Unlink account" confirmLabel="Unlink" onconfirm={unlink}>
	<strong>{unlinking ? label(unlinking) : ''}</strong> ({unlinking?.display || unlinking?.subject}) will no longer sign
	in as you.
</ConfirmDialog>
