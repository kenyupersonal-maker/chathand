#!/bin/bash
# System-tool bootstrap: never execute a quarantined App or replace the Node
# process that is coordinating this installation.
set -euo pipefail
umask 077

[ "$(/usr/bin/uname -s)" = Darwin ] || { echo MAC_REQUIRED >&2; exit 1; }
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
INSTALLER_APP="$(cd "$SCRIPT_DIR/../../../../../.." && pwd -P)"
REQUIREMENT='=identifier "com.kenyu.chathand" and certificate leaf = H"13D3EF5EB9C743427123452CD966CBC8FD9ECF2D"'

# INSTALL.md asks the caller to verify this App before reading its installer.
# Recheck here before copying or executing any bundled binary.
/usr/bin/codesign --verify --deep --strict -R "$REQUIREMENT" "$INSTALLER_APP"
TEMP_BASE="${TMPDIR:-/tmp}"
STAGING_ROOT="$(/usr/bin/mktemp -d "${TEMP_BASE%/}/chathand-installer.XXXXXX")"
trap '/bin/rm -rf -- "$STAGING_ROOT"' EXIT
BOOTSTRAP_APP="$STAGING_ROOT/ChatHand.app"
/usr/bin/ditto "$INSTALLER_APP" "$BOOTSTRAP_APP"
/usr/bin/codesign --verify --deep --strict -R "$REQUIREMENT" "$BOOTSTRAP_APP"
/usr/bin/xattr -dr com.apple.quarantine "$BOOTSTRAP_APP"
ATTRIBUTES="$(/usr/bin/xattr -lr "$BOOTSTRAP_APP")"
if [[ "$ATTRIBUTES" == *com.apple.quarantine:* ]]; then
  echo QUARANTINE_STILL_PRESENT >&2
  exit 1
fi
unset ATTRIBUTES

# The source may be a different, older package selected by the user. Installer
# code stays in this verified disposable copy until the whole operation ends.
RUNTIME="$BOOTSTRAP_APP/Contents/Resources/runtime"
/usr/bin/env -u NODE_OPTIONS -u NODE_PATH "$RUNTIME/bin/node" --no-addons \
  "$RUNTIME/skills/chathand-setup/scripts/install-and-start.mjs" \
  --source "$INSTALLER_APP" "$@"
