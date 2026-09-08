"""Build the portable HTML artifact using only the Python standard library."""
from pathlib import Path

root = Path(__file__).resolve().parent
html = (root / 'index.html').read_text(encoding='utf-8')
css = (root / 'styles.css').read_text(encoding='utf-8')
js = (root / 'app.js').read_text(encoding='utf-8')
html = html.replace('  <link rel="stylesheet" href="styles.css?v=0.4">', f'  <style>\n{css}\n  </style>')
html = html.replace('  <script src="app.js?v=0.4" defer></script>', '')
html = html.replace('</body>', f'<script>\n{js}\n</script>\n</body>')
target = root / 'EarLab_v0.2.html'
target.write_text(html, encoding='utf-8')
print(f'Built {target.name} ({target.stat().st_size:,} bytes)')
