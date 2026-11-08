<script lang="ts">
	let { size = 48, class: className = '' }: { size?: number; class?: string } = $props();
</script>

<svg viewBox="0 0 512 512" width={size} height={size} class={className} aria-hidden="true">
	<rect width="512" height="512" rx="112" fill="#7289da" />
	<g fill="#fff" fill-rule="evenodd" transform="translate(-6 0)">
		<path d="M92 148H184A108 108 0 0 1 184 364H92ZM146 202V310H184A54 54 0 0 0 184 202Z" />
		<path d="M320 148H432V200H374V232H412V282H374V364H320Z" />
	</g>
</svg>
