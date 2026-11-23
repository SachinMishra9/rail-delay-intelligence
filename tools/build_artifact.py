"""Make dist/artifact.html: index.html without the document skeleton (claude.ai adds its own)."""
import re, pathlib
src = pathlib.Path('index.html').read_text()
head = re.search(r'<head>(.*?)</head>', src, re.S).group(1)
body = re.search(r'<body>(.*?)</body>', src, re.S).group(1)
head = re.sub(r'<meta charset[^>]*>\s*|<meta name="viewport"[^>]*>\s*', '', head)
pathlib.Path('dist').mkdir(exist_ok=True)
pathlib.Path('dist/artifact.html').write_text(head.strip() + '\n' + body.strip() + '\n')
