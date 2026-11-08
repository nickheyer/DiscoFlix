import adapter from '@sveltejs/adapter-static';
import tailwindcss from '@tailwindcss/vite';
import { withPwa } from '@vite-pwa/sveltekit';
import { defineConfig } from 'vite';

const backend = 'http://127.0.0.1:5001';

export default defineConfig({
	plugins: [
		tailwindcss(),
		withPwa(
			{
				adapter: adapter({ pages: 'build', assets: 'build', fallback: '200.html', precompress: true })
			},
			{
				strategies: 'generateSW',
				base: '/',
				scope: '/',
				registerType: 'autoUpdate',
				injectRegister: false,
				kit: { adapterFallback: '200.html', spa: true },
				manifest: {
					name: 'DiscoFlix',
					short_name: 'DiscoFlix',
					description: 'Search, download, catalog, and request media',
					display: 'standalone',
					start_url: '/',
					scope: '/',
					theme_color: '#202225',
					background_color: '#202225',
					icons: [
						{ src: '/pwa-64x64.png', sizes: '64x64', type: 'image/png' },
						{ src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
						{ src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
						{ src: '/maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
					]
				},
				generateSW: {
					navigateFallback: '200.html',
					navigateFallbackAllowlist: [
						/^\/$/,
						/^\/s\//,
						/^\/catalog/,
						/^\/login/,
						/^\/setup/,
						/^\/settings/,
						/^\/link\//
					],
					globPatterns: [
						'client/**/*.{js,css,ico,png,svg,webp,webmanifest}',
						'client/**/noto-sans-latin-wght-normal*.woff2'
					],
					globStrict: false,
					runtimeCaching: [
						{
							urlPattern: /\/_app\/immutable\/assets\/.+\.woff2$/,
							handler: 'CacheFirst',
							options: { cacheName: 'discoflix-fonts', expiration: { maxEntries: 16 } }
						}
					]
				}
			}
		)
	],
	server: {
		port: 5173,
		strictPort: true,
		proxy: {
			'/discoflix.': { target: backend },
			'/connection': { target: backend, ws: true },
			'/auth': { target: backend },
			'/blobs': { target: backend },
			'/catalog/snapshot': { target: backend, ws: true }
		}
	}
});
