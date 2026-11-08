import { describe, expect, it } from 'vitest';
import { redirectFor, safeNext } from './routing';

const at = (href: string) => new URL(href, 'http://df.local');

describe('redirectFor', () => {
	it('sends every path to setup until the first admin exists', () => {
		expect(redirectFor('setup', at('/s/a/c/b'), true)).toBe('/setup');
		expect(redirectFor('setup', at('/setup'), true)).toBeNull();
	});

	it('sends anonymous users to sign in and remembers deep links', () => {
		expect(redirectFor('anonymous', at('/settings/users?x=1'), true)).toBe('/login?next=%2Fsettings%2Fusers%3Fx%3D1');
		expect(redirectFor('anonymous', at('/'), true)).toBe('/login');
		expect(redirectFor('anonymous', at('/setup'), true)).toBe('/login');
		expect(redirectFor('anonymous', at('/login'), true)).toBeNull();
	});

	it('drops the deep link after an explicit sign out', () => {
		expect(redirectFor('anonymous', at('/settings/profile'), false)).toBe('/login');
	});

	it('returns signed-in users from auth pages to their destination', () => {
		expect(redirectFor('ready', at('/login?next=%2Fs%2Fa%2Fc%2Fb'), true)).toBe('/s/a/c/b');
		expect(redirectFor('ready', at('/setup'), true)).toBe('/');
		expect(redirectFor('ready', at('/s/a'), true)).toBeNull();
	});

	it('waits while the session is loading or failed', () => {
		expect(redirectFor('loading', at('/x'), true)).toBeNull();
		expect(redirectFor('error', at('/x'), true)).toBeNull();
	});
});

describe('safeNext', () => {
	it('rejects targets outside the app', () => {
		expect(safeNext('//evil.example')).toBe('/');
		expect(safeNext('/\\evil.example')).toBe('/');
		expect(safeNext('https://evil.example')).toBe('/');
		expect(safeNext('/login?next=/x')).toBe('/');
		expect(safeNext(null)).toBe('/');
		expect(safeNext('/settings/users')).toBe('/settings/users');
	});
});
