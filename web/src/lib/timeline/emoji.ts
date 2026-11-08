// Emoji offered in the picker, grouped the way people look for them
export const EMOJI_GROUPS: { label: string; emoji: string[] }[] = [
	{
		label: 'Reactions',
		emoji: ['👍', '👎', '❤️', '🔥', '😂', '😮', '😢', '🎉', '👀', '✅', '❌', '🤔', '🙏', '💯', '👏', '🚀']
	},
	{
		label: 'Faces',
		emoji: ['😀', '😄', '😅', '🤣', '😊', '😍', '😎', '🥳', '😐', '😴', '🤯', '🥺', '😡', '🤡', '💀', '🫠']
	},
	{
		label: 'Media',
		emoji: ['🎬', '📺', '🍿', '🎵', '🎧', '📚', '🎮', '📀', '💾', '⬇️', '⏳', '⭐', '🏆', '🔔', '📌', '🧹']
	}
];

// Splits a custom emoji key of the form name:id into its parts
export function customEmoji(emoji: string): { name: string; id: string } | null {
	const at = emoji.lastIndexOf(':');
	if (at <= 0 || !/^\d+$/.test(emoji.slice(at + 1))) return null;
	return { name: emoji.slice(0, at), id: emoji.slice(at + 1) };
}
