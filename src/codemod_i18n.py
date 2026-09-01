#!/usr/bin/env python3
"""Codemod: wrap JSX text nodes and text attributes containing Cyrillic in t()."""
import re, glob, sys

CYR = 'А-Яа-яЁё'
# text node: >Текст<  (first non-space char must be Cyrillic; no quotes/braces inside)
re_text_lt = re.compile(r'>([ \t]*[' + CYR + r'][^<>{}\"\'\n]*?)[ \t]*(?=<)')
# text node: >Текст{  (text before an expression)
re_text_brace = re.compile(r'>([ \t]*[' + CYR + r'][^<>{}\"\'\n]*?)[ \t]*(?=\{)')
# text node after expression: }Текст<
re_text_after = re.compile(r'\}([ \t]*[' + CYR + r'][^<>{}\"\'\n]*?)[ \t]*(?=<)')
# attributes
re_attr = re.compile(r'\b(placeholder|title|aria-label)="([^"\n]*[' + CYR + r'][^"\n]*)"')

def esc(s):
    return s.replace('\\', '\\\\').replace("'", "\\'")

changed = []
files = glob.glob('pages/*.tsx') + [f for f in glob.glob('components/*.tsx')]
for f in files:
    src = open(f, encoding='utf-8').read()
    orig = src
    src = re_attr.sub(lambda m: f"{m.group(1)}={{t('{esc(m.group(2))}')}}", src)
    src = re_text_lt.sub(lambda m: ">{t('%s')}<" % esc(m.group(1).strip()), src)
    src = re_text_brace.sub(lambda m: ">{t('%s')}" % esc(m.group(1).strip()), src)
    src = re_text_after.sub(lambda m: "}{t('%s')}<" % esc(m.group(1).strip()), src)
    if src != orig:
        if "lib/i18n" not in src:
            # insert import after last import line
            lines = src.split('\n')
            last_imp = max(i for i, l in enumerate(lines) if l.startswith('import '))
            lines.insert(last_imp + 1, "import { t } from '@/lib/i18n'")
            src = '\n'.join(lines)
        open(f, 'w', encoding='utf-8').write(src)
        changed.append(f)
print('\n'.join(changed))
print(f'CHANGED: {len(changed)}', file=sys.stderr)
