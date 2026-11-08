type Listener = () => void;

const listeners = new Set<Listener>();

// Registers a callback run when a protected call reports the session is gone
export function onUnauthenticated(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function emitUnauthenticated(): void {
	for (const listener of listeners) listener();
}
