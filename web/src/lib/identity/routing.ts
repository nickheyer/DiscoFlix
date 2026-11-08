export type SessionStatus = 'loading' | 'error' | 'setup' | 'anonymous' | 'ready';

const AUTH_PATHS = ['/login', '/setup'];

export interface RouteUrl {
	pathname: string;
	search: string;
	searchParams: { get(name: string): string | null };
}

// Accepts only same-origin app paths so a crafted next parameter cannot leave the app
export function safeNext(next: string | null): string {
	if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
	return AUTH_PATHS.some((p) => next === p || next.startsWith(`${p}?`) || next.startsWith(`${p}/`)) ? '/' : next;
}

// Returns where the app must go for a session state, or null when the current path is allowed
export function redirectFor(status: SessionStatus, url: RouteUrl, remember: boolean): string | null {
	const path = url.pathname;
	switch (status) {
		case 'setup':
			return path === '/setup' ? null : '/setup';
		case 'anonymous':
			if (path === '/login') return null;
			if (!remember || path === '/' || path === '/setup') return '/login';
			return `/login?next=${encodeURIComponent(path + url.search)}`;
		case 'ready':
			return AUTH_PATHS.includes(path) ? safeNext(url.searchParams.get('next')) : null;
		default:
			return null;
	}
}
