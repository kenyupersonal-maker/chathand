# 配置流程
## 1. 自检与路线
repair 先 doctor，只修目标，不配对、新建 Site/插件或换路；add 只配目标，留另一条，真测过再切。出错按故障索引排查，未列出的继续调查；用户动作按 plan-check 交接后续做，不因不确定就结束。
设 `APP` 为本次目标，`RUNTIME="$APP/Contents/Resources/runtime"`；`setup` 即 `"$RUNTIME/bin/node" "$RUNTIME/skills/chathand-setup/scripts/setup.mjs"`。先 `setup doctor`，只看脱敏结果。路径失效先定位；`APP_PATH_MISMATCH` 核目标与后台，目标已运行就用它的助手，需要安装/切换则照 `Contents/Resources/codex/INSTALL.md` 的一键入口做，按返回的 `app_path` 重设路径，不默认沿用旧副本。技能缺失读 `$RUNTIME/skills/chathand-setup/SKILL.md`。`connected=true` 保留当前路线；未配置就继续，已有连接不通先恢复。用户明确换路才 `setup switch --route openai|site`。首次未选路线默认 OpenAI 通道（第3节）；已选/已配 Site 走第2节。保留已有插件和健康连接，不清资料或重建密钥，不编地址、不假报完成。
App 路径不存在或 doctor 无法运行时，按实际错误排查路径、权限和运行异常，不把自检失败当成云端会话的证据。缺少本机能力时说明实际缺口和下一步。
连接/等待字段见[接口](connection-api.md)。
从安装盘运行也先按 INSTALL 正式安装，再用返回路径继续；其他正常安装位置沿用。
## 2. ChatGPT Site
用 `setup site-start` 取提示词、`template_path`、`template_sha256`、等待编号/有效期。读该路径已核验 App 随带 ZIP，核本机 pin、ZIP SHA-256、归档 manifest/成员摘要；不让用户拖。缺文件/摘要不符即停，不用远端/开发模板；提示词仅本次用且不进日志。 SITE_NETWORK_CHALLENGED/SITE_NETWORK_UNREACHABLE：原文告知并问改用 OpenAI；同意才 `setup switch --route openai`。
核本机会话 Sites 建库/迁移/部署正式接口；齐全本机做，缺项逐一报。不猜网页 Work，先核接口；AI 能自动交接同 ZIP/步骤至同项目并复核摘要才转部署；否则留续接点、报缺口、问是否改用 OpenAI，不自行换路。配对用本次 `site-start` 的 `pairing_hash`，最多24小时，以返回期限为准，到期重取；回本机格式 `chathand-site-v2`。
按本机绑定身份或当前 Site 地址/通道筛选，唯一可用就用，不问/另建。名字像、账号仅一个不算本机目标；多个按绑定消歧，不试别台电脑。
按 ZIP 的 `STEPS.md` 在同一 Site 项目建库、迁移、私有部署并核验。先查项目和检查点，中断按归档恢复；响应丢失或结果未知先查现状，不重复创建、部署或重生密钥。Site 秘密只在部署环境生成和使用，不打印。
Site 凭据由受控 stdin 交给 `setup site`；不能把真实凭据放参数、heredoc、文件或日志。无私密 stdin 按模板代码块交接，告知对话留存凭据；AI 点 Copy，当前有效配对等待自动接收。先核 ChatHand 的收到及配对结果，再关闭交接页面；未收到不报完成。手动配置可在 ChatHand 粘贴，无须真人按键证明。
同 Site 换凭据沿用交接，留身份/PIN/配对记录/数据，不重新认主人。清单被拒先重传，仍拒则按模板更新同一 Site 后核实；Mac 更新不等于 Site 更新。`connection_stages` 分核配对、清单、设备、ChatGPT 登记、最近调用，配对成功不等于全通。
`B_REBIND_UNSUPPORTED` 先 `update_site_template` 更新同一 Site，成功重配，确认失败才 `create_new_site`；保留原 Site/配置/失败码。超时/丢回包/进行中/未知先查同一部署并恢复，不算失败。新建成功重配，确认失败才给 OpenAI 选项，不自动切；更新/新建不问，撞绑定重问。`B_FIELDS_INVALID` 不等于旧模板；health 缺版本不按请求/本机 pin 倒推。重装留原私钥可重绑；仅名字/安装编号视为新设备。
`B_BINDING_CONFLICT`：按语言选返回的 `prompt.zh`/`prompt.en`，提问框原文展示 `question`、有序 `options[].label`，保留 `id`；不改字/顺序、不加选项、不拼名字/时间。每次重问；旧对话、前一天、本对话旧回答均无效，只收当前 `question_id` 提问后同会话的新回答。重问/换会话/过期重取；问题编号不是授权。`replace_supported=true` 才给改连：v7 走授权页，旧版本次选改连后原地升 v7、重配重问；确认升级失败才 false，按两选项重问。缺页/能力不猜、不改连。
本次选改连后，用完整 `replacement.authorization_url` 打开同一 Site 的 `/owner/rebind`，AI 点「授权 / Authorize」再 Copy、不读授权，运行 `setup site-replace --grant-from-clipboard`；授权不进 URL/对话/参数/文件/日志。仅验签 `paired` 和 `replacement_accepted` 都 true 且剪贴板未变才清。冲突失效/授权过期按返回重配重问；网络未知先恢复同交易，不重发授权。未核模板/页面不报可用。
## 3. OpenAI 通道
默认/已选 OpenAI 执行本节。AI 在用户自己的浏览器里打开 OpenAI 官方 Secure MCP Tunnel 入口，核组织、工作区、本机通道；唯一候选见第2节。管理需 Tunnels Read+Manage，Restricted 运行密钥仅给 Tunnels Read+Use，不用其他 API 密钥替代。连不上先查网络/代理。
建运行密钥时，用户只点一下「Create secret key」。AI 在用户浏览器打开 API keys 页，填名并选 Restricted 及上述权限，切最前，立即用非阻塞提问工具显示：「请点击『Create secret key』，60 分钟内我会自动检测并继续。超时后完成创建，请点『已点击创建』通知我。」提问必须附带「已点击创建」「遇到问题」两个可点击选项，不只留文字输入框。英文提问：「Click “Create secret key”. I’ll watch for up to 60 minutes and continue automatically. After that, select “Created” when done.」选项：Created、Having trouble。
提问后继续观察同页，每隔 20 秒只检查密钥弹窗的控件状态，最多 60 分钟；不要发出提问就结束，也不因暂未收到回复停止观察。密钥框出现即 Copy 并接着配置，不要用户另报「已经点了创建」；不念、不记、不描述密钥。用户回复「已点击创建」时立即核对并继续；回复「遇到问题」时转入排查，要求停止时停止。60 分钟到后结束观察、保留提问，告知创建后点「已点击创建」即可接着处理。
AI 自己点框里密钥旁边的 Copy，用 `setup connect --tunnel-id <实际公开ID> --key-from-clipboard` 交给助手。密钥只在那个框里显示一次，不进对话、日志和回复。回 `CLIPBOARD_NOT_A_KEY` 就说「没读到，我再复制一次」，再点 Copy、交接，最多三次，这期间框一直开着。费用只说：「这把密钥只用来连接通道，不会产生模型调用费用。」AI 确实不能 Copy 才把框切到用户看得见的浏览器最前请用户复制；不能读剪贴板才用 ChatHand 手动入口，不重复生密钥。
助手私下读剪贴板，经主人认证写本地加密文件、核保存，再清空仍是同一密钥的剪贴板，不输出密钥或尾号。`saved=true`、`received=true`、`storage_verified=true` 才能关平台密钥弹窗；未确认就留框、诊断代码，不叫人代存。`clipboard_cleared` 如实报告，连接另核；`CONNECTION_PENDING` 不等于没存好。手动 ⌘V 入口仍须拒绝非密钥剪贴板。
## 4. Chrome 插件与系统权限
需要浏览器控制才 `setup prepare-browser`，按返回商店或扩展目录安装，不猜路径、不碰其他 Chrome 用户。Chrome 添加确认按 plan-check 交给用户；目标用户中的助手真握手才算装好，失败报阶段/原因码。`CHROME_DATA_ACCESS_DENIED` 是 macOS 拒绝访问 Chrome 设置，不是找不到用户：在可见窗口打开隐私与安全性，请用户允许 ChatHand；两分钟内回 App 自动续装，超时再点安装。具体系统询问/位置留待真机核实，不猜开关。卸载继续处理其他项，单列残留登记文件。
需要桌面控制时 AI 打开系统设置对应隐私页，按 plan-check 请用户打开当前 ChatHand 的辅助功能、屏幕录制开关，回来核实际状态；没用到的权限不冒充已验收。
## 5. 认出 ChatGPT 中这台 Mac 的插件
本机连通后，AI 在用户自己的浏览器里打开 ChatGPT 的插件设置。沿用旧插件只认两种：`doctor` 的 `chatgpt_app_identity` 记着的那一个；或者连接目标正好是这台现在的 Site 地址或通道的那一个。名字像不算。找到了先刷新工具，在新对话里真调一次 `connection_check`，回来的 `instance_id` 跟 `doctor` 的 `instance_id` 一样才沿用。一个都没有、刷新后再调一次还不通、或者 `instance_id` 对不上，就直接新建，使用 `chatgpt_app_name_suggested`，跟列表里的近似名分开（重名加 -2、-3）。不挨个去试列表里别的旧插件，不为这个问用户，不删任何插件。
AI 开启页面需要的开发者模式，创建或复用后连接。把权限设为「允许使用所有工具」时，优先使用 Plugin Management 管理接口：
- `app_id` 使用同一插件的 `asdk_app_…`；Site 插件为 `asdk_app_sites_…`。若已核对的真实详情页给出 `plugin_asdk_app_…`，只去掉最前面的 `plugin_`，其余原样保留。例如详情页 `/settings/plugins-settings/plugin_asdk_app_sites_<id>` 对应权限接口 `asdk_app_sites_<id>`。`connector_sites_…` 属于连接器标识，不传给权限接口，也不据它猜插件 ID。
- 用户已明确要求「允许使用所有工具」时，直接对这个 `app_id` 调用 `update_app_permissions`，`updates` 为 `{"app_permissions":[{"value":"full_access"}]}`，不重复询问同一授权，不修改全局或其他插件权限。核返回 `status=updated`，再用 `get_app_permissions` 确认同一插件的专属权限为 Allow all actions；目标已是该权限时保留。
- 返回 `not_installed` 时，先核同一详情页和接口 ID；若误传了网页 ID，按上面的规则修正后重试一次。规范 ID 仍未识别，再核目标连接状态和管理接口支持情况。单独的 `not_installed` 不作为新建、删除插件或转去网页改权限的依据；只有确认管理接口不可用，才使用网页后备并遵守浏览器的实际确认要求。结果未知先查当前权限，不反复写入。
权限确认后点刷新工具。运行 `setup bind-app --application-id <实际ID> --detail-url <同一详情页HTTPS地址> --app-name <实际名称>`；只绑定真实详情页的对象，不猜 ID。此处保留实际观察到的 ID 和详情页 URL，权限接口使用的 ID 单独处理。绑定换 ID 后要做新的测试，旧 verified 不作数；健康 Site/通道保持不动。
插件描述不写版本号；复用时去掉旧版号。
若创建暂时被平台拒绝，先核本机连接；连接健康则每隔一分钟重试一次，最多三次，仍不行保留位置、原因码和续接点，不换路线或重建连接。可用 `scripts/connector-icon.mjs` 的随包图标上传，失败跳过，不为图标卡住。
## 6. 真实测试与交回
「插件存在、权限正确」只算平台配置；「ChatGPT 已连上这台 Mac」须有目标插件新普通对话的真实读写，`instance_id` 与本机一致。只做 doctor 或插件配置时，真实连通仍写未验证。
先确认这个插件的权限是「允许使用所有工具」、点过「刷新工具」，再从这个插件自己的详情页新开普通对话，不从别的对话选它。运行 `setup test-start`（明确重配才加 `--restart`），新对话发送完整口令，真实调用 `connection_check` 和 `setup_write_probe`，不从本机伪造调用。前者核 version、tool_count、schema_sha256。再 `setup test-status`：OpenAI 通道只有当前挑战 `read_write`、未过期且已 verified 才完成；Site 以当前 Site 这两次真实调用为准，测试回执按 `site_id` 关联且不过期。Site 的长期测试回执不代表私有凭据授权或接口当前健康。

走 Site 时第一次报「Tunnel-client has not been seen for 300 seconds」或 `NOT_FOUND` 不算失败：多半是选成了旧插件或工具表没刷新。回这个插件的详情页再点一次「刷新工具」，从详情页新开普通对话再试一次；第二次还这样才按故障索引查。
桌面 ChatHand 的配置窗口到了完成页才算配完。验收后保留完成页，文件访问范围和辅助能力留给用户选择；AI 不点击「完成」「关闭」或「打开 ChatGPT」，不代用户离开完成页。分别报告本机连接、插件权限、真实读写、卡片/回复、浏览器和桌面权限；未做写未验证。调用成功不等于显示正常，doctor 不等于目标对话成功。显示失败保留读写结果、记录资源/渲染证据，不重建连接。保持当前配置对话的续接点，别用新任务抹掉旧失败。
