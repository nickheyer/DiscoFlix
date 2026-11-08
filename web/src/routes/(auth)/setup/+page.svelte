<script lang="ts">
	import { identityClient } from '#lib/api/clients';
	import { errorText } from '#lib/api/errors';
	import { session } from '#lib/identity/session.svelte';
	import { Button } from '#lib/ui/button';
	import { Input } from '#lib/ui/input';
	import { Label } from '#lib/ui/label';

	let username = $state('');
	let displayName = $state('');
	let password = $state('');
	let confirm = $state('');
	let instanceName = $state('DiscoFlix');
	let busy = $state(false);
	let error = $state('');

	const usernameError = $derived(
		username === '' || /^[a-z0-9._-]{2,32}$/.test(username)
			? ''
			: 'Use 2 to 32 lowercase letters, digits, dots, dashes, or underscores'
	);
	const passwordError = $derived(password === '' || password.length >= 12 ? '' : 'Use at least 12 characters');
	const confirmError = $derived(confirm === '' || confirm === password ? '' : 'Passwords do not match');
	const valid = $derived(
		/^[a-z0-9._-]{2,32}$/.test(username) &&
			displayName.trim().length > 0 &&
			password.length >= 12 &&
			password === confirm &&
			instanceName.length <= 64
	);

	async function submit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		if (!valid) return;
		busy = true;
		error = '';
		try {
			await identityClient.bootstrap({
				username,
				displayName: displayName.trim(),
				password,
				instanceName: instanceName.trim()
			});
			await session.signedIn();
		} catch (err) {
			error = errorText(err);
		} finally {
			busy = false;
		}
	}
</script>

{#snippet field(id: string, label: string, hint: string)}
	<Label for={id} class="text-xs font-bold tracking-wide uppercase {hint ? 'text-dnd' : 'text-interactive'}">
		{label}
		{#if hint}<span class="font-normal normal-case italic">({hint})</span>{/if}
	</Label>
{/snippet}

<h1 class="text-center text-2xl font-semibold text-header">Set up DiscoFlix</h1>
<p class="mt-1 text-center text-interactive">Create the administrator account for this server</p>

<form class="mt-6 space-y-4" onsubmit={submit} novalidate>
	<div class="space-y-2">
		{@render field('instance', 'Server name', instanceName.length > 64 ? 'At most 64 characters' : '')}
		<Input id="instance" bind:value={instanceName} maxlength={64} class="h-10 border-0 bg-tertiary" />
	</div>
	<div class="space-y-2">
		{@render field('username', 'Username', usernameError)}
		<Input
			id="username"
			bind:value={username}
			autocomplete="username"
			autocapitalize="none"
			spellcheck={false}
			required
			maxlength={32}
			aria-invalid={usernameError !== ''}
			class="h-10 border-0 bg-tertiary"
		/>
	</div>
	<div class="space-y-2">
		{@render field('display', 'Display name', '')}
		<Input id="display" bind:value={displayName} required maxlength={64} class="h-10 border-0 bg-tertiary" />
	</div>
	<div class="space-y-2">
		{@render field('password', 'Password', passwordError)}
		<Input
			id="password"
			type="password"
			bind:value={password}
			autocomplete="new-password"
			required
			minlength={12}
			maxlength={256}
			aria-invalid={passwordError !== ''}
			class="h-10 border-0 bg-tertiary"
		/>
	</div>
	<div class="space-y-2">
		{@render field('confirm', 'Confirm password', confirmError)}
		<Input
			id="confirm"
			type="password"
			bind:value={confirm}
			autocomplete="new-password"
			required
			aria-invalid={confirmError !== ''}
			class="h-10 border-0 bg-tertiary"
		/>
	</div>
	<Button type="submit" class="h-11 w-full text-base" disabled={!valid || busy}>
		{busy ? 'Creating administrator' : 'Create administrator'}
	</Button>
	{#if error}
		<p class="text-sm text-dnd" role="alert">{error}</p>
	{/if}
</form>
