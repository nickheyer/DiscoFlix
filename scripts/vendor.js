// VENDORS EVERY THIRD-PARTY BROWSER ASSET INTO public/vendor SO THE CONSOLE
// WORKS OFFLINE WITH NO CDN OR SUPPLY-CHAIN EXPOSURE. RUN VIA `npm run vendor`
// AFTER BUMPING A PIN BELOW, THEN COMMIT THE OUTPUT.
const fs = require('fs/promises');
const path = require('path');

const VENDOR_DIR = path.resolve(__dirname, '../public/vendor');
const FONTS_DIR = path.join(VENDOR_DIR, 'fonts');

// PINNED TO THE EXACT VERSIONS THE CONSOLE SHIPPED AGAINST
const FILES = [
  { url: 'https://unpkg.com/htmx.org@1.9.10/dist/htmx.min.js', out: 'htmx.min.js' },
  { url: 'https://unpkg.com/htmx.org@1.9.10/dist/ext/ws.js', out: 'htmx-ws.js' },
  { url: 'https://unpkg.com/hyperscript.org@0.9.13/dist/_hyperscript.min.js', out: '_hyperscript.min.js' },
  { url: 'https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js', out: 'Sortable.min.js' },
  { url: 'https://cdn.jsdelivr.net/npm/sweetalert2@11.14.5/dist/sweetalert2.min.js', out: 'sweetalert2.min.js' },
  { url: 'https://cdn.jsdelivr.net/npm/@sweetalert2/theme-dark@5.0.27/dark.css', out: 'sweetalert2-dark.css' },
  { url: 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js', out: 'bootstrap.bundle.min.js' }
];

const FONT_CSS_URL = 'https://fonts.googleapis.com/css2?family=Roboto:ital,wght@0,300;0,400;0,500;0,700;0,900;1,300;1,400;1,500&display=swap';
// A MODERN UA IS REQUIRED OR GOOGLE SERVES LEGACY TTF CSS
const FONT_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function fetchBytes(url, headers = {}) {
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function vendorFiles() {
  for (const file of FILES) {
    const bytes = await fetchBytes(file.url);
    await fs.writeFile(path.join(VENDOR_DIR, file.out), bytes);
    console.log(`vendored ${file.out} (${bytes.length} bytes)`);
  }
}

async function vendorFonts() {
  const css = (await fetchBytes(FONT_CSS_URL, { 'User-Agent': FONT_UA })).toString('utf8');
  const seen = new Map();
  let counter = 0;

  const localized = css.replace(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g, (match, url) => {
    if (!seen.has(url)) {
      seen.set(url, `roboto-${String(++counter).padStart(2, '0')}.woff2`);
    }
    return `url(/vendor/fonts/${seen.get(url)})`;
  });

  for (const [url, name] of seen) {
    await fs.writeFile(path.join(FONTS_DIR, name), await fetchBytes(url));
  }
  await fs.writeFile(path.join(FONTS_DIR, 'fonts.css'), localized);
  console.log(`vendored fonts.css + ${seen.size} woff2 files`);
}

async function main() {
  await fs.mkdir(FONTS_DIR, { recursive: true });
  await vendorFiles();
  await vendorFonts();
  console.log('vendor complete');
}

main().catch(err => {
  console.error(`vendor failed: ${err.message}`);
  process.exit(1);
});
