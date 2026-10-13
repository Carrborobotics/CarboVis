"""Web build for claude.ai: writes source/index.html (no document wrapper; the artifact viewer adds it)."""
import pathlib
d = pathlib.Path(__file__).parent
page = (d/'page.html').read_text()
js = '\n'.join((d/f).read_text() for f in ['vendor.js','core.js','sample.js','mechviz.js','nt4.js','live.js','fakematch.js','robot3d.js','matchview.js','app.js'])
(d/'index.html').write_text(page + '\n<script>\n' + js + '\n</script>\n')
print('built', len(page)+len(js))
