<script lang="ts">
	import type { Snippet } from 'svelte';
	import { errorText } from '#lib/api/errors';
	import * as AlertDialog from '#lib/ui/alert-dialog';

	let {
		open = $bindable(false),
		title,
		confirmLabel,
		onconfirm,
		children
	}: {
		open?: boolean;
		title: string;
		confirmLabel: string;
		onconfirm: () => Promise<void>;
		children: Snippet;
	} = $props();

	let busy = $state(false);
	let error = $state('');

	// Runs the action and keeps the dialog open with the error when it fails
	async function confirm(e: MouseEvent): Promise<void> {
		e.preventDefault();
		busy = true;
		error = '';
		try {
			await onconfirm();
			open = false;
		} catch (err) {
			error = errorText(err);
		} finally {
			busy = false;
		}
	}
</script>

<AlertDialog.Root
	bind:open
	onOpenChange={(next) => {
		if (next) error = '';
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{title}</AlertDialog.Title>
			<AlertDialog.Description>{@render children()}</AlertDialog.Description>
		</AlertDialog.Header>
		{#if error}
			<p class="text-sm text-dnd" role="alert">{error}</p>
		{/if}
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={busy}>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action class="bg-dnd text-white hover:bg-dnd/90" disabled={busy} onclick={confirm}>
				{confirmLabel}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
