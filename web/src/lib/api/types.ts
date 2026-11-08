import { createMutableRegistry } from '@bufbuild/protobuf';
import { file_google_protobuf_struct } from '@bufbuild/protobuf/wkt';

// Holds every message type the client can decode from an Any, cards register into it
export const typeRegistry = createMutableRegistry(file_google_protobuf_struct);
