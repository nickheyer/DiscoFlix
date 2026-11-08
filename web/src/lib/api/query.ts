import { Code, ConnectError } from '@connectrpc/connect';
import { QueryClient } from '@tanstack/svelte-query';

const terminal = new Set([
	Code.Unauthenticated,
	Code.PermissionDenied,
	Code.NotFound,
	Code.InvalidArgument,
	Code.FailedPrecondition
]);

// Retries transient failures twice and never retries auth or validation errors
export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 30_000,
			retry: (count, err) => count < 2 && !terminal.has(ConnectError.from(err).code)
		}
	}
});
