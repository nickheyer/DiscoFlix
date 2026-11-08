import type { MessageInitShape } from '@bufbuild/protobuf';
import { createConnectQueryKey, createQueryOptions } from '@connectrpc/connect-query-core';
import { transport } from '#lib/api/transport';
import {
	CatalogService,
	type ResolveTitleRequestSchema,
	type SearchEntitiesRequestSchema
} from '#lib/gen/discoflix/catalog/v1/catalog_pb';

export function catalogStatusQuery() {
	return createQueryOptions(CatalogService.method.getCatalogStatus, {}, { transport });
}

export function catalogStatusKey() {
	return createConnectQueryKey({ schema: CatalogService.method.getCatalogStatus, input: {}, cardinality: 'finite' });
}

export function entityQuery(id: string) {
	return createQueryOptions(CatalogService.method.getEntity, { id }, { transport });
}

export function entityKey(id: string) {
	return createConnectQueryKey({ schema: CatalogService.method.getEntity, input: { id }, cardinality: 'finite' });
}

export function searchQuery(input: MessageInitShape<typeof SearchEntitiesRequestSchema>) {
	return createQueryOptions(CatalogService.method.searchEntities, input, { transport });
}

export function resolveQuery(input: MessageInitShape<typeof ResolveTitleRequestSchema>) {
	return createQueryOptions(CatalogService.method.resolveTitle, input, { transport });
}
