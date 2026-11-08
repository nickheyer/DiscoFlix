import { Code } from '@connectrpc/connect';
import { onUnauthenticated } from '#lib/api/auth-signal';
import { identityClient } from '#lib/api/clients';
import { errorText, hasCode } from '#lib/api/errors';
import { queryClient } from '#lib/api/query';
import type { GetMeResponse, GetServerInfoResponse, User } from '#lib/gen/discoflix/identity/v1/identity_pb';
import { timeline } from '#lib/timeline/store.svelte';
import type { SessionStatus } from './routing';

class Session {
	status = $state<SessionStatus>('loading');
	info = $state.raw<GetServerInfoResponse | null>(null);
	me = $state.raw<GetMeResponse | null>(null);
	error = $state('');
	rememberPath = $state(true);
	user = $derived<User | undefined>(this.me?.user);
	isAdmin = $derived(this.me?.user?.systemAdmin ?? false);
	#verifying: Promise<void> | null = null;

	constructor() {
		onUnauthenticated(() => void this.verify());
	}

	// Reads server info then the caller, landing on setup, anonymous, ready, or error
	async load(): Promise<void> {
		this.status = 'loading';
		this.error = '';
		try {
			this.info = await identityClient.getServerInfo({});
			if (this.info.setupRequired) {
				this.#end('setup');
				return;
			}
			this.#begin(await identityClient.getMe({}));
		} catch (err) {
			if (hasCode(err, Code.Unauthenticated)) {
				this.#end('anonymous');
			} else {
				this.error = errorText(err);
				this.status = 'error';
			}
		}
	}

	#begin(me: GetMeResponse): void {
		if (!me.user) throw new Error('The server returned no user for this session');
		this.me = me;
		this.rememberPath = true;
		timeline.start(me.user.id, queryClient);
		this.status = 'ready';
	}

	#end(status: SessionStatus): void {
		timeline.stop();
		queryClient.clear();
		this.me = null;
		this.status = status;
	}

	// Enters the app after a sign-in call set the session cookie
	async signedIn(): Promise<void> {
		this.info = await identityClient.getServerInfo({});
		this.#begin(await identityClient.getMe({}));
	}

	async refreshMe(): Promise<void> {
		this.me = await identityClient.getMe({});
	}

	async signOut(): Promise<void> {
		try {
			await identityClient.logout({});
		} catch (err) {
			if (!hasCode(err, Code.Unauthenticated)) throw err;
		}
		this.rememberPath = false;
		this.#end('anonymous');
	}

	// Confirms the session is gone before sending the user to sign in
	verify(): Promise<void> {
		if (this.status !== 'ready') return Promise.resolve();
		this.#verifying ??= identityClient
			.getMe({})
			.then(
				(me) => {
					this.me = me;
				},
				(err) => {
					if (hasCode(err, Code.Unauthenticated)) this.#end('anonymous');
				}
			)
			.finally(() => (this.#verifying = null));
		return this.#verifying;
	}
}

export const session = new Session();
