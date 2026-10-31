"""Packaging text uses the same flat catalogs; no browser language assumption."""
import json
import pathlib
import re
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent

def normalize_locale(value):
    if not isinstance(value, str) or len(value) > 128:
        return 'zh'
    return 'en' if re.fullmatch(r'en(?:-[a-z0-9]+)*', value.strip().replace('_', '-').lower()) else 'zh'

def system_locale():
    try:
        result = subprocess.run(['/usr/bin/defaults', 'read', '-g', 'AppleLanguages'], capture_output=True, text=True, timeout=1.5)
        first = re.search(r'["(\s]([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*)[",\s)]', result.stdout) if result.returncode == 0 else None
        return normalize_locale(first.group(1) if first else None)
    except (OSError, subprocess.TimeoutExpired):
        return 'zh'

def local_text(key, parameters=None, locale='zh'):
    tables = {language: json.loads((ROOT / 'locales' / (language + '.json')).read_text()) for language in ('zh', 'en')}
    chinese = tables['zh'].get(key)
    if not isinstance(chinese, str) or not chinese.strip():
        raise ValueError('I18N_CHINESE_MISSING ' + key)
    english = tables['en'].get(key)
    sentence = english if normalize_locale(locale) == 'en' and isinstance(english, str) and english.strip() else chinese
    params = parameters or {}
    return re.sub(r'\{([A-Za-z][A-Za-z0-9_]*)\}', lambda match: str(params.get(match.group(1), match.group(0))), sentence)
