import { getContext, setContext } from 'svelte';
import type { MentionResolver } from './markdown';
import { noMentions } from './markdown';

const KEY = Symbol('mentions');

// Shares one mention resolver with every message rendered under the channel page
export function provideMentions(resolver: () => MentionResolver): void {
	setContext(KEY, resolver);
}

export function useMentions(): () => MentionResolver {
	return getContext<() => MentionResolver>(KEY) ?? (() => noMentions);
}
