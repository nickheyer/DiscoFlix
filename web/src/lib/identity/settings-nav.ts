export interface SettingsLink {
	href: string;
	label: string;
	admin: boolean;
}

export const settingsLinks: SettingsLink[] = [
	{ href: '/settings/profile', label: 'My account', admin: false },
	{ href: '/settings/connections', label: 'Connections', admin: false },
	{ href: '/settings/passkeys', label: 'Passkeys', admin: false },
	{ href: '/settings/api-keys', label: 'API keys', admin: false },
	{ href: '/settings/sessions', label: 'Sessions', admin: false },
	{ href: '/settings/users', label: 'Users', admin: true },
	{ href: '/settings/discord', label: 'Discord', admin: true },
	{ href: '/settings/catalog', label: 'Catalog', admin: true },
	{ href: '/settings/capabilities', label: 'Capabilities', admin: true }
];

let returnTo = '/';

export function setSettingsReturn(path: string): void {
	if (!path.startsWith('/settings')) returnTo = path;
}

export function settingsReturn(): string {
	return returnTo;
}
