const fallbacks = ['#7289da', '#43b581', '#faa61a', '#f04747', '#747f8d', '#593695', '#1abc9c'];

// Picks a stable avatar color from an id unless the user chose an accent
export function avatarColor(id: string, accent = ''): string {
	if (/^#[0-9a-f]{6}$/i.test(accent)) return accent;
	let hash = 0;
	for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
	return fallbacks[Math.abs(hash) % fallbacks.length];
}

// Builds up to three uppercase initials from the words of a name
export function initials(name: string): string {
	const words = name
		.trim()
		.split(/[\s._-]+/)
		.filter(Boolean);
	if (words.length === 0) return '?';
	if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
	return words
		.slice(0, 3)
		.map((w) => w[0])
		.join('')
		.toUpperCase();
}
