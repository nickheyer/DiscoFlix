import type { Source } from '#lib/gen/discoflix/catalog/v1/catalog_pb';

export const MAX_PEERS = 16;
export const MAX_PEER_LENGTH = 512;

// Splits the peers box into unique trimmed lines and explains the first limit broken
export function parsePeers(text: string): { peers: string[]; error: string } {
	const peers = [...new Set(text.split('\n').map((line) => line.trim()))].filter((line) => line !== '');
	if (peers.length > MAX_PEERS) return { peers, error: `Up to ${MAX_PEERS} peers are allowed` };
	const long = peers.find((p) => p.length > MAX_PEER_LENGTH);
	if (long) return { peers, error: `Each peer address must be at most ${MAX_PEER_LENGTH} characters` };
	return { peers, error: '' };
}

export function overBudget(source: Source): boolean {
	return source.budget > 0 && source.callsToday >= source.budget;
}
