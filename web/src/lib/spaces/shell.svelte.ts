const RIGHT_KEY = 'df.rightRail';

function readFlag(key: string, fallback: boolean): boolean {
	try {
		const value = localStorage.getItem(key);
		return value === null ? fallback : value === '1';
	} catch {
		return fallback;
	}
}

function writeFlag(key: string, value: boolean): void {
	try {
		localStorage.setItem(key, value ? '1' : '0');
	} catch {
		return;
	}
}

// Holds drawer and rail visibility shared by the shell layout and channel header
class Shell {
	navOpen = $state(false);
	rightOpen = $state(false);
	rightDocked = $state(readFlag(RIGHT_KEY, true));

	toggleRight(mobile: boolean): void {
		if (mobile) {
			this.rightOpen = !this.rightOpen;
			return;
		}
		this.rightDocked = !this.rightDocked;
		writeFlag(RIGHT_KEY, this.rightDocked);
	}
}

export const shell = new Shell();

const LAST_SPACE = 'df.lastSpace';

export function rememberChannel(spaceId: string, channelId: string): void {
	try {
		localStorage.setItem(LAST_SPACE, spaceId);
		localStorage.setItem(`df.lastChannel.${spaceId}`, channelId);
	} catch {
		return;
	}
}

export function lastSpace(): string | null {
	try {
		return localStorage.getItem(LAST_SPACE);
	} catch {
		return null;
	}
}

export function lastChannel(spaceId: string): string | null {
	try {
		return localStorage.getItem(`df.lastChannel.${spaceId}`);
	} catch {
		return null;
	}
}

export function readCollapsed(categoryId: string): boolean {
	return readFlag(`df.collapsed.${categoryId}`, false);
}

export function writeCollapsed(categoryId: string, collapsed: boolean): void {
	writeFlag(`df.collapsed.${categoryId}`, collapsed);
}
