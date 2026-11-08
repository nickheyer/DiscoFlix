import { createConnectQueryKey, createQueryOptions } from '@connectrpc/connect-query-core';
import { transport } from '#lib/api/transport';
import { TimelineService } from '#lib/gen/discoflix/timeline/v1/timeline_pb';

export function spacesQuery() {
	return createQueryOptions(TimelineService.method.listSpaces, {}, { transport });
}

export function channelsQuery(spaceId: string) {
	return createQueryOptions(TimelineService.method.listChannels, { spaceId }, { transport });
}

export function spacesKey() {
	return createConnectQueryKey({ schema: TimelineService.method.listSpaces, cardinality: 'finite' });
}

export function channelsKey(spaceId?: string) {
	return createConnectQueryKey({
		schema: TimelineService.method.listChannels,
		cardinality: 'finite',
		...(spaceId === undefined ? {} : { input: { spaceId } })
	});
}
