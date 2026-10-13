"""Driver station build: one offline HTML document (fonts inlined, no CDN), plus installer scripts and icon."""
import base64, pathlib, re
web = pathlib.Path(__file__).parent
out = web.parent / 'app'
out.mkdir(parents=True, exist_ok=True)
fonts = web / 'fonts'
faces = [('IBM Plex Sans', 'ibm-plex-sans', w) for w in (400, 500, 600)] + [('IBM Plex Mono', 'ibm-plex-mono', w) for w in (400, 500)] + [('Barlow Condensed', 'barlow-condensed', w) for w in (600, 700)]
css = ''
for fam, pkg, w in faces:
    f = fonts / f'{pkg}-latin-{w}-normal.woff2'
    css += f"@font-face{{font-family:'{fam}';font-style:normal;font-weight:{w};font-display:swap;src:url(data:font/woff2;base64,{base64.b64encode(f.read_bytes()).decode()}) format('woff2')}}\n"
page = (web / 'page.html').read_text()
page = re.sub(r'<link rel="preconnect"[^>]*>\n?', '', page)
page = re.sub(r'<link rel="stylesheet" href="https://fonts.googleapis.com[^>]*>\n?', '', page)
title = re.search(r'<title>.*?</title>', page).group(0)
page = page.replace(title, '')
js = '\n'.join((web / f).read_text() for f in ['vendor.js', 'core.js', 'sample.js', 'mechviz.js', 'nt4.js', 'live.js', 'fakematch.js', 'robot3d.js', 'matchview.js', 'app.js'])
doc = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
{title}
<style>
{css}:root{{color-scheme:light}}body{{margin:0;font:14px system-ui,-apple-system,"Segoe UI",sans-serif}}img{{max-width:100%}}[hidden]{{display:none!important}}
</style>
<script>window.FRC_DESKTOP = true;</script>
</head>
<body>
{page}
<script>
{js}
</script>
</body>
</html>
"""
(out / 'FRC7763-Match-Logs.html').write_text(doc, encoding='utf-8')
print('desktop html', round(len(doc) / 1e6, 2), 'MB')
