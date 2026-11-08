<script lang="ts">
	import { page } from '$app/state';
	import { identityClient } from '#lib/api/clients';
	import { errorText } from '#lib/api/errors';
	import type { FinishLinkCodeResponse } from '#lib/gen/discoflix/identity/v1/identity_pb';
	import { session } from '#lib/identity/session.svelte';
	import Mark from '#lib/theme/Mark.svelte';
	import { Button } from '#lib/ui/button';

	const code = $derived(page.params.code ?? '');
	let result = $state<FinishLinkCodeResponse | null>(null);
	let error = $state('');
	let busy = $state(false);

	// Redeems the code once the session is known, so the Discord account lands on the signed-in user
	async function finish(): Promise<void> {
		busy = true;
		error = '';
		try {
			result = await identityClient.finishLinkCode({ code });
			await session.refreshMe();
		} catch (err) {
			error = errorText(err);
		} finally {
			busy = false;
		}
	}

	$effect(() => {
		if (session.status === 'ready' && code && !result && !error && !busy) void finish();
	});
</script>

<svelte:head>
	<title>Link Discord</title>
</svelte:head>

<main class="flex app-height flex-col items-center justify-center gap-4 bg-chat p-6 text-center">
	<Mark size={64} class={busy ? 'animate-pulse' : ''} />
	{#if result}
		<h1 class="text-xl font-semibold text-header">Discord account linked</h1>
		<p class="max-w-sm text-sm text-interactive">
			<strong class="text-header">{result.identity?.display}</strong> now signs in as
			<strong class="text-header">{session.user?.displayName}</strong>.
			{#if result.merged}
				Messages that account already wrote in Discord now show under your name, and an administrator can split the two
				again from Users.
			{/if}
		</p>
		<Button href="/settings/connections">Open connections</Button>
	{:else if error}
		<h1 class="text-xl font-semibold text-header">This link did not work</h1>
		<p class="max-w-sm text-sm text-dnd" role="alert">{error}</p>
		<p class="max-w-sm text-sm text-interactive">Run /link in Discord again to get a fresh one.</p>
		<Button href="/" variant="secondary">Back to DiscoFlix</Button>
	{:else}
		<p class="text-sm text-interactive" role="status">Linking your Discord account</p>
	{/if}
</main>
