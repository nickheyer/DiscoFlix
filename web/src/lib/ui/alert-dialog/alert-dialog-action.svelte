<script lang="ts">
	import { AlertDialog as AlertDialogPrimitive } from 'bits-ui';
	import { buttonVariants, type ButtonVariant, type ButtonSize } from '#lib/ui/button/index.js';
	import { cn } from '#lib/ui/utils.js';

	let {
		ref = $bindable(null),
		class: className,
		variant = 'default',
		size = 'default',
		...restProps
	}: AlertDialogPrimitive.ActionProps & {
		variant?: ButtonVariant;
		size?: ButtonSize;
	} = $props();
</script>

<AlertDialogPrimitive.Action
	bind:ref
	data-slot="alert-dialog-action"
	class={cn(buttonVariants({ variant, size }), '', className)}
	{...restProps}
/>
