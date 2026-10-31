#!/bin/bash
# Bootstrap messages before Node is available. JSON remains the only text source.
set -euo pipefail
text_root="$(cd "$(dirname "$0")/.." && pwd)"
text_key="${1:?I18N_KEY_REQUIRED}"
if command -v node >/dev/null 2>&1; then
  exec node "$text_root/scripts/local-text.mjs" "$text_key"
fi
# Developer bootstrap without Node uses Chinese, as specified for missing locale.
# plutil is part of macOS; no browser-language or shell LANG inference is made.
text_keypath="${text_key//./\\.}"
if [ -x /usr/bin/plutil ]; then
  exec /usr/bin/plutil -extract "$text_keypath" raw -o - "$text_root/locales/zh.json"
fi
printf '%s\n' "$text_key"
printf '[i18n] I18N_RESOURCE_UNAVAILABLE\n' >&2
