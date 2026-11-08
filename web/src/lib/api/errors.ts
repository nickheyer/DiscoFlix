import { Code, ConnectError } from '@connectrpc/connect';

const labels: Partial<Record<Code, string>> = {
	[Code.Unauthenticated]: 'You are signed out',
	[Code.PermissionDenied]: 'You do not have permission to do that',
	[Code.NotFound]: 'Not found',
	[Code.AlreadyExists]: 'That already exists',
	[Code.InvalidArgument]: 'Some fields are invalid',
	[Code.FailedPrecondition]: 'The server refused the request in its current state',
	[Code.ResourceExhausted]: 'Too many requests, try again shortly',
	[Code.Unavailable]: 'The server is unreachable',
	[Code.DeadlineExceeded]: 'The server took too long to answer',
	[Code.Internal]: 'The server hit an internal error'
};

// Turns any thrown value into the text shown inline, preferring the server explanation
export function errorText(err: unknown): string {
	const e = ConnectError.from(err);
	const raw = e.rawMessage.trim();
	if (raw) return raw[0].toUpperCase() + raw.slice(1);
	return labels[e.code] ?? Code[e.code];
}

export function hasCode(err: unknown, code: Code): boolean {
	return ConnectError.from(err).code === code;
}
