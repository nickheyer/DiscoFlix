<script lang="ts">
	import { createConnectQueryKey, createQueryOptions } from '@connectrpc/connect-query-core';
	import { createQueries, createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { SvelteMap } from 'svelte/reactivity';
	import { discordClient } from '#lib/api/clients';
	import { errorText } from '#lib/api/errors';
	import { transport } from '#lib/api/transport';
	import { DiscordService, type DiscordGuild } from '#lib/gen/discoflix/discord/v1/discord_pb';
	import { ChannelKind } from '#lib/gen/discoflix/timeline/v1/timeline_pb';
	import { session } from '#lib/identity/session.svelte';
	import { channelsQuery } from '#lib/spaces/queries';
	import { formatAgo, toDate } from '#lib/theme/format';
	import AdminOnly from '#lib/ui/AdminOnly.svelte';
	import { Button } from '#lib/ui/button';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import CopyButton from '#lib/ui/CopyButton.svelte';
	import { Input } from '#lib/ui/input';
	import { Label } from '#lib/ui/label';
	import SettingsSection from '#lib/ui/SettingsSection.svelte';

	const client = useQueryClient();
	const statusKey = createConnectQueryKey({
		schema: DiscordService.method.getDiscordStatus,
		input: {},
		transport,
		cardinality: 'finite'
	});
	const status = createQuery(() => ({
		...createQueryOptions(DiscordService.method.getDiscordStatus, {}, { transport }),
		enabled: session.isAdmin,
		refetchInterval: (q) => (q.state.data?.status?.state === 'connecting' ? 2000 : 15000)
	}));
	const st = $derived(status.data?.status);
	const guilds = $derived(st?.guilds ?? []);
	const guildChannels = createQueries(() => ({
		queries: guilds.filter((g) => g.spaceId).map((g) => channelsQuery(g.spaceId))
	}));

	let botToken = $state('');
	let clientSecret = $state('');
	let saving = $state(false);
	let saveError = $state('');
	let disconnectOpen = $state(false);
	const approvalsBusy = new SvelteMap<string, string>();

	const states: Record<string, { label: string; tone: string }> = {
		connected: { label: 'Connected', tone: 'bg-online' },
		connecting: { label: 'Connecting', tone: 'bg-idle' },
		failed: { label: 'Failed', tone: 'bg-dnd' },
		disconnected: { label: 'Not connected', tone: 'bg-faint' }
	};

	async function save(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		saving = true;
		saveError = '';
		try {
			await discordClient.configureDiscord({ botToken: botToken.trim(), clientSecret: clientSecret.trim() });
			botToken = '';
			clientSecret = '';
			await client.invalidateQueries({ queryKey: statusKey });
			await session.load();
		} catch (err) {
			saveError = errorText(err);
		} finally {
			saving = false;
		}
	}

	async function disconnect(): Promise<void> {
		await discordClient.disconnectDiscord({});
		await client.invalidateQueries({ queryKey: statusKey });
		await session.load();
	}

	function textChannels(guild: DiscordGuild) {
		const i = guilds.filter((g) => g.spaceId).findIndex((g) => g.id === guild.id);
		return (guildChannels[i]?.data?.channels ?? []).filter((c) => c.kind === ChannelKind.TEXT);
	}

	async function setApprovals(guild: DiscordGuild, channelId: string): Promise<void> {
		approvalsBusy.set(guild.id, '');
		try {
			await discordClient.setApprovalsChannel({ spaceId: guild.spaceId, channelId });
			await client.invalidateQueries({ queryKey: statusKey });
			approvalsBusy.delete(guild.id);
		} catch (err) {
			approvalsBusy.set(guild.id, errorText(err));
		}
	}
</script>

<AdminOnly>
	<SettingsSection title="Connection" description="One bot mirrors every server it is in into a space">
		{#if status.isError}
			<p class="text-sm text-dnd" role="alert">{errorText(status.error)}</p>
		{:else if st}
			{@const s = states[st.state] ?? states.disconnected}
			<div class="flex flex-wrap items-center gap-3 rounded-lg bg-sidebar px-4 py-3">
				<span class="size-3 rounded-full {s.tone}"></span>
				<span class="font-semibold text-header">{s.label}</span>
				{#if st.botUsername}
					<span class="flex items-center gap-2 text-sm text-interactive">
						{#if st.botAvatarUrl}
							<img src={st.botAvatarUrl} alt="" class="size-6 rounded-full" />
						{/if}
						as <strong class="text-header">{st.botUsername}</strong>
					</span>
				{/if}
				{#if st.connectedAt}
					{@const at = toDate(st.connectedAt)}
					<span class="text-xs text-faint">since {at ? formatAgo(at) : ''}</span>
				{/if}
				{#if st.configured}
					<Button variant="destructive" size="sm" class="ml-auto" onclick={() => (disconnectOpen = true)}
						>Disconnect</Button
					>
				{/if}
			</div>
			{#if st.error}
				<p class="mt-2 rounded bg-dnd/15 p-3 text-sm text-dnd" role="alert">{st.error}</p>
			{/if}
			{#if st.commands.length > 0}
				<p class="mt-2 text-xs text-faint">
					Slash commands registered from the capability registry: {st.commands.join(', ')}
				</p>
			{/if}
		{/if}
	</SettingsSection>

	<SettingsSection
		title="Credentials"
		description="From the Discord developer portal, Bot tab for the token and OAuth2 tab for the client secret"
	>
		<form class="space-y-3" onsubmit={save}>
			<div class="space-y-1">
				<Label for="bot-token" class="text-xs font-bold tracking-wide text-interactive uppercase">Bot token</Label>
				<Input
					id="bot-token"
					type="password"
					bind:value={botToken}
					autocomplete="off"
					placeholder={st?.configured ? 'Stored, enter a new one to replace it' : 'Paste the bot token'}
					class="h-10 border-0 bg-tertiary font-mono"
				/>
			</div>
			<div class="space-y-1">
				<Label for="client-secret" class="text-xs font-bold tracking-wide text-interactive uppercase">
					Client secret, for Discord sign-in and account linking
				</Label>
				<Input
					id="client-secret"
					type="password"
					bind:value={clientSecret}
					autocomplete="off"
					placeholder={st?.loginEnabled
						? 'Stored, enter a new one to replace it'
						: 'Optional until people sign in with Discord'}
					class="h-10 border-0 bg-tertiary font-mono"
				/>
			</div>
			<p class="text-xs text-faint">
				Enable the Server Members, Presence, and Message Content privileged intents on the Bot tab, the mirror needs all
				three.
			</p>
			<Button type="submit" disabled={saving || (botToken.trim() === '' && clientSecret.trim() === '')}>
				{saving ? 'Checking with Discord' : st?.configured ? 'Save and reconnect' : 'Connect'}
			</Button>
			{#if saveError}
				<p class="text-sm text-dnd" role="alert">{saveError}</p>
			{/if}
		</form>
		{#if st?.applicationId}
			<dl class="mt-4 grid gap-3 text-sm">
				<div>
					<dt class="text-xs font-semibold text-interactive">Invite the bot to a server</dt>
					<dd class="mt-1 flex flex-wrap items-center gap-2">
						<a href={st.inviteUrl} target="_blank" rel="noopener noreferrer" class="text-link hover:underline"
							>Open the invite</a
						>
						<CopyButton value={st.inviteUrl} label="Copy link" />
					</dd>
				</div>
				<div>
					<dt class="text-xs font-semibold text-interactive">OAuth2 redirect to add in the developer portal</dt>
					<dd class="mt-1 flex flex-wrap items-center gap-2">
						<code class="rounded bg-tertiary px-2 py-1 font-mono text-xs text-normal"
							>{st.redirectUrl || 'Set --public-url so this server knows its own address'}</code
						>
						{#if st.redirectUrl}
							<CopyButton value={st.redirectUrl} />
						{/if}
					</dd>
				</div>
			</dl>
		{/if}
	</SettingsSection>

	<SettingsSection title="Servers" description="Each mirrored server is a space, pick where its approval cards land">
		{#if guilds.length === 0}
			<p class="text-sm text-faint">
				{st?.state === 'connected'
					? 'The bot is not in any server yet, use the invite above.'
					: 'Servers appear here once the bot connects.'}
			</p>
		{:else}
			<ul class="divide-y divide-divider rounded-lg bg-sidebar">
				{#each guilds as guild (guild.id)}
					<li class="flex flex-wrap items-center gap-3 px-4 py-3">
						{#if guild.iconUrl}
							<img src={guild.iconUrl} alt="" class="size-10 rounded-2xl" />
						{:else}
							<span class="flex size-10 items-center justify-center rounded-2xl bg-chat text-sm font-semibold"
								>{guild.name.slice(0, 2)}</span
							>
						{/if}
						<span class="min-w-0 flex-1 basis-40">
							<span class="block truncate font-medium text-header">{guild.name}</span>
							<span class="block text-xs text-faint">
								{guild.memberCount} members{guild.available ? '' : ', unavailable on Discord right now'}
							</span>
							{#if guild.spaceId}
								<a href="/s/{guild.spaceId}" class="text-xs text-link hover:underline">Open space</a>
							{/if}
						</span>
						{#if guild.spaceId}
							<label class="flex items-center gap-2 text-xs text-interactive">
								Approvals
								<select
									class="h-8 rounded bg-tertiary px-2 text-sm text-normal outline-none focus:ring-2 focus:ring-ring"
									value={guild.approvalsChannelId}
									onchange={(e) => setApprovals(guild, e.currentTarget.value)}
								>
									<option value="">System #audit</option>
									{#each textChannels(guild) as channel (channel.id)}
										<option value={channel.id}>#{channel.name}</option>
									{/each}
								</select>
							</label>
							{#if approvalsBusy.get(guild.id)}
								<span class="basis-full text-xs text-dnd" role="alert">{approvalsBusy.get(guild.id)}</span>
							{/if}
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</SettingsSection>
</AdminOnly>

<ConfirmDialog bind:open={disconnectOpen} title="Disconnect Discord" confirmLabel="Disconnect" onconfirm={disconnect}>
	The bot token and client secret are forgotten and the gateway closes. Mirrored history stays, nothing new arrives
	until you connect again.
</ConfirmDialog>
