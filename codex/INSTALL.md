# ChatHand 安装与配置
适用 Apple 芯片 Mac、macOS 14+。安装提示词已授权安装/配置，AI 能做的直接做。平台点 Copy，运行密钥交助手，不读取/打印/写进聊天/日志/截图。只用随 App 程序，不装 Node 或依赖。
## 本机执行环境
用 ChatGPT 本机执行工具，不通过待退出的 ChatHand 执行。需要工具权限时申请；出错先排查、修复并继续。实际缺少本机执行能力才引导回桌面本机会话，不凭自检失败猜成云端。
## 1. 确定来源
只配置且已装 `/Applications/ChatHand.app`，核身份后配置；其他有效安装位置也沿用。健康连接保留。用户选中的包照装，含要求 AI 下载的版本。已挂载就用卷内实际路径。
未指定才查已挂载盘和「下载」，按请求确定目标；只有没有 App、也没有可用包才请用户提供。失效路径重新定位。用 `hdiutil attach -nobrowse "<实际DMG路径>"` 挂载，记录实际卷路径。
## 2. 核验身份
来源须执行 `codesign --verify --deep --strict --verbose=2 "<App路径>"`、`codesign -dr - "<App路径>" 2>&1` 并成功；identifier 为 `com.kenyu.chathand`、leaf SHA-1 为 `13D3EF5EB9C743427123452CD966CBC8FD9ECF2D`（忽略大小写）。失败先查原因，必要时重取同一目标包。旧 App 损坏可备份后由可信包修复。
受限环境报 `CSSMERR_TP_NOT_TRUSTED` 先记为「验签未完成」，通过可用本机工具对同一 App 重验。通过后继续；仍失败按实际错误调查，不绕过验签。

### 优先使用一键安装入口
第 2 节核验通过后，运行已核验 App 随包的这一条命令，`--source` 填本次选中的 App：
```sh
/bin/bash "<已核验的安装器App>/Contents/Resources/runtime/skills/chathand-setup/scripts/install-and-start.sh" --source "<本次选中的App>"
```
参数与续接见 [一键安装](../runtime/skills/chathand-setup/references/install-and-start.md)。成功直接去第 6 节；失败排查后继续。
## 4. 正常退出和保留一份旧 App
需要替换时，用已装 App 自带的 Node 调 `setup quit`，主人认证请求 `/api/lifecycle/quit`。不使用界面钥匙、强退或 osascript。按原先核实的 PID、程序路径和启动时间确认原生与后台都已退出，HTTP、helper 和等待共用最多 12 秒。整个退出过程不得弹出任何 macOS 授权或自动化询问框；出现就停下，不点击。用已装 Node 读取第 2 节核过签名的新盘脚本：
```sh
INCOMING_APP="<已核验的卷内 ChatHand.app 完整路径>"
env -u NODE_OPTIONS -u NODE_PATH "/Applications/ChatHand.app/Contents/Resources/runtime/bin/node" --no-addons "$INCOMING_APP/Contents/Resources/runtime/skills/chathand-setup/scripts/setup.mjs" quit
```
清标记前只许现装 App 的 Node 读新盘 quit 脚本，不加载新盘其它脚本、可执行程序或 .node 原生模块。命令清预载变量、禁原生附加模块，不运行下载包的可执行程序。12 秒没退报 `QUIT_TIMEOUT`，先查具体进程和退出状态，再用核实过的正常退出入口继续处理；确实需要用户退出时，定位菜单栏「ChatHand → Quit」。不备份、不复制、不移动仍运行的 App，排查完成后继续安装。
旧 App 身份核过且已退出，备份固定在 `$HOME/Library/Application Support/ChatHand/manual-install/previous.app`。目录逐级拒绝符号链接；旧备份存在时先核同一 bundle ID 和证书，只有确认是自己的旧 App 才移除以替换，未知内容不碰并报告冲突。创建该目录后，把 `/Applications/ChatHand.app` 移到这个固定位置，只保留最近这一份，不复制或清理 `data/`、凭据、连接或历史。首次安装没有旧 App 就跳过。
## 5. 复制、清下载标记，再运行
确认目标 App 已不存在。`VOL` 用第 1 节实际卷路径，复制/卸载均用它；操作失败先修复对应步骤。顺序：复制 → 签名复核 → 清下载标记 → 核实清掉 → 运行。用 `xattr -l /Applications/ChatHand.app` 核验，这之后才允许运行新 App 内的可执行程序。quit 例外只由已装 Node 读已验签脚本，不执行新盘二进制。
```sh
VOL="<第 1 节找到的实际卷路径>"
ditto "$VOL/ChatHand.app" "/Applications/ChatHand.app" || exit 1
codesign --verify --deep --strict --verbose=2 "/Applications/ChatHand.app" || exit 1
xattr -dr com.apple.quarantine "/Applications/ChatHand.app" || { echo QUARANTINE_CLEAR_FAILED; exit 1; }
APP_ATTRIBUTES=$(xattr -l "/Applications/ChatHand.app") || { echo QUARANTINE_VERIFY_FAILED; exit 1; }
if printf '%s\n' "$APP_ATTRIBUTES" | grep -q '^com.apple.quarantine:'; then echo QUARANTINE_STILL_PRESENT; exit 1; fi
unset APP_ATTRIBUTES
hdiutil detach "$VOL" || echo DISK_EJECT_DEFERRED
cd "/Applications/ChatHand.app/Contents/Resources/runtime" || exit 1
"$PWD/bin/node" --input-type=module -e 'import("./app/v09/local-setup.mjs").then(({installSkill}) => console.log(JSON.stringify(installSkill())))' || exit 1
open -g "/Applications/ChatHand.app"
```
不先跑 `install-build.mjs` 比版本，不先运行被拦程序再请人点「仍要打开」。只清目标 App 标记，不关系统保护。已有健康连接的更新可跳过安装配置助手一行、保留配置，其余不跳。
复制后若验签环境受限，换可用本机工具重验同一副本；通过后从清标记处继续。仍失败按下文恢复，报告副本位置和具体解决步骤。
复制、签名或清标记失败时，不运行新 App；失败副本移入用 mktemp -d 创建的临时隔离目录，旧备份移回原 App 路径并正常打开，报告原始错误。恢复失败如实报，未核验不得称装好。整个过程不改用户资料。
## 6. 接着配置并交回
读取 `Contents/Resources/runtime/skills/chathand-setup/SKILL.md`，照它配置。桌面 ChatHand 的配置窗口到了完成页才算配完。安装成功、连接健康、ChatGPT 实际调用分别报告；未验证不能算通过。用户动作由技能的 plan-check 统一规定。最后报实际版本/build/路线/进度/剩余原因码。
