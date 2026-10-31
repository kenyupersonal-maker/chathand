#!/bin/bash
# 由人在「终端」里运行：从当前提交打签名包，用升级事务装到 /Applications/ChatHand.app。
# 用途：第一次装带 request_update 的版本；以后 request_update 出问题时兜底。
# AI 不能用它：ChatHand 起的进程运行它会被拒绝（日常换新版走 request_update + 用户在 ChatHand 窗口点「安装」）。
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(uname -s)" = "Darwin" ] || { bash scripts/local-text.sh installer.developer.macRequired; exit 1; }

# 往上查父进程：由 ChatHand（它的 App 或运行时）起的就拒绝。
pid=$$
while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
  cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)
  case "$cmd" in
    */ChatHand.app/Contents/*) bash scripts/local-text.sh installer.developer.humanOnly; exit 9 ;;
  esac
  pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
done
[ -t 0 ] || { bash scripts/local-text.sh installer.developer.terminalRequired; exit 9; }

if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="$HOME/.nvm"
  [ ! -s "${NVM_DIR}/nvm.sh" ] || . "${NVM_DIR}/nvm.sh"
fi
command -v node >/dev/null 2>&1 || { bash scripts/local-text.sh installer.developer.nodeMissing; exit 2; }

if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  node scripts/local-text.mjs installer.developer.dirty; git status --short; exit 3
fi
BUILD=$(node -p 'require("./package.json").kenBridge.build_number')
VERSION=$(node -p 'require("./package.json").version')
SHA=$(git rev-parse --short HEAD)
OUT="${CHATHAND_BUILDS_ROOT:-$HOME/Developer/ChatHand-builds.noindex}/BUILD-${BUILD}.noindex/dev-builds.noindex/${SHA}"
APP=/Applications/ChatHand.app
[ ! -e "${OUT}" ] || { node scripts/local-text.mjs installer.developer.exists "path=${OUT}"; exit 4; }

node scripts/local-text.mjs installer.developer.plan "version=${VERSION}" "build=${BUILD}" "commit=${SHA}" "path=${APP}"
node scripts/local-text.mjs installer.developer.backup
read -r -p "$(node scripts/local-text.mjs installer.developer.confirm)" answer
[ "$answer" = "y" ] || { node scripts/local-text.mjs installer.developer.cancelled; exit 0; }

mkdir -p "${OUT}"
node scripts/build-v09.mjs --output "${OUT}/build/ChatHand.app"
node scripts/prepare-mac-local-package.mjs "${OUT}/build/ChatHand.app" "${OUT}/package"
R="${OUT}/package/ChatHand.app/Contents/Resources/runtime"
"${R}/bin/node" "${R}/scripts/upgrade.mjs" --install "${OUT}/package" --destination "${APP}" --result "$HOME/Library/Application Support/ChatHand/data/update-result.json"
node scripts/local-text.mjs installer.developer.finished "build=${BUILD}"
