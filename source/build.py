"""Builds the app page: one offline HTML document (fonts inlined, no CDN) plus the files that make it an installable
web app. Output goes to desktop/web/, which the desktop installer bundles and GitHub Pages serves as-is."""
import base64, pathlib, re, shutil
src = pathlib.Path(__file__).parent
out = src.parent / 'desktop' / 'web'
out.mkdir(parents=True, exist_ok=True)
JS = ['vendor.js', 'core.js', 'sample.js', 'mechviz.js', 'nt4.js', 'live.js', 'recorder.js', 'fakematch.js', 'robot3d.js', 'matchview.js', 'library.js', 'app.js']

fonts = src / 'fonts'
faces = [('IBM Plex Sans', 'ibm-plex-sans', w) for w in (400, 500, 600)] + [('IBM Plex Mono', 'ibm-plex-mono', w) for w in (400, 500)] + [('Barlow Condensed', 'barlow-condensed', w) for w in (600, 700)]
css = ''
for fam, pkg, w in faces:
    f = fonts / f'{pkg}-latin-{w}-normal.woff2'
    css += f"@font-face{{font-family:'{fam}';font-style:normal;font-weight:{w};font-display:swap;src:url(data:font/woff2;base64,{base64.b64encode(f.read_bytes()).decode()}) format('woff2')}}\n"
page = (src / 'page.html').read_text(encoding='utf-8')
page = re.sub(r'<link rel="preconnect"[^>]*>\n?', '', page)
page = re.sub(r'<link rel="stylesheet" href="https://fonts.googleapis.com[^>]*>\n?', '', page)
title = re.search(r'<title>.*?</title>', page).group(0)
page = page.replace(title, '')
js = '\n'.join((src / f).read_text(encoding='utf-8') for f in JS)
doc = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
{title}
<meta name="theme-color" content="#0b6872">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon-192.png">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<style>
{css}:root{{color-scheme:light}}body{{margin:0;font:14px system-ui,-apple-system,"Segoe UI",sans-serif}}img{{max-width:100%}}[hidden]{{display:none!important}}
</style>
</head>
<body>
{page}
<script>
{js}
</script>
<script>
// installable + works offline once visited (GitHub Pages; service workers need https)
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {{}});
</script>
</body>
</html>
"""
(out / 'index.html').write_text(doc, encoding='utf-8')

(out / 'manifest.webmanifest').write_text("""{
  "name": "CarboVis - Carrborobotics Match Logs",
  "short_name": "CarboVis",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "background_color": "#eef0ee",
  "theme_color": "#0b6872",
  "icons": [
    { "src": "icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ]
}
""", encoding='utf-8')

# Network first, so a new version shows up on the next visit; the cached copy is only for when there's no signal.
(out / 'sw.js').write_text("""const CACHE = 'carbovis';
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', 'manifest.webmanifest', 'icon-192.png']))); });
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // GitHub API and log downloads go straight to the network
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
""", encoding='utf-8')
for f in (src / 'icons').iterdir():
    shutil.copy(f, out / f.name)
print('built', out, round(len(doc) / 1e6, 2), 'MB')
