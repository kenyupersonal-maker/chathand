# 故障索引
安装见随包 INSTALL.md，配置见 [runbook](runbook.md)，用户动作见 [plan-check](../plan-check.md)。
表外错误继续查状态、日志及必要的官方资料，修复后复核并继续；重复失败要改变排查方向。需要本人操作或确实无法继续时，说明具体解决步骤和续接点。
| 现象或代码 | 处理 |
| --- | --- |
| `APP_NOT_RUNNING` | 按目标完整路径启动，等后台就绪再 doctor；失败查日志。 |
| `APP_PATH_MISMATCH` | 核目标，使用正确助手或走 INSTALL 一键入口，按返回路径继续。 |
| 一键安装 `incomplete` | 按阶段、错误和恢复结果修复后重试；损坏包重取同一目标，本地未发布包不擅换线上版本。 |
| 一键安装 `ready` 带 `warnings` | 技能登记失败读 `skill_path`；安装盘稍后推出，继续配置。 |
| `OWNER_UNREACHABLE` | 核 App/后台运行与版本；不读运行秘密、不重建通道。 |
| `CLIPBOARD_NOT_A_KEY` | 平台密钥弹窗保持打开，跟用户说一句「没读到，我再复制一次」，AI 再点 Copy、再交接，最多三次；不要把通道 ID 当密钥，不打印剪贴板。 |
| `KEY_SAVE_UNCONFIRMED` 或交接被拒 | 留一次性弹窗、记录代码、查助手与主人认证，不用人工粘贴代替诊断。 |
| 已存好、连接仍待定 | 沿用这份配置，检查连接和网络；不重复生成密钥或通道。 |
| `B_PAIRING_INTENT_MISSING` / `B_PAIRING_INTENT_EXPIRED` | 重取本机 site-start，按同项目模板恢复，不复用过期哈希。 |
| `B_TEMPLATE_MISMATCH` / `MANIFEST_TOO_LARGE` | 核同 Site 模板、清单阶段和字节数；按随包模板更新原 Site，不重新配对。 |
| `B_REBIND_UNSUPPORTED` | 按 runbook 第 2 节先更新原 ChatGPT Site；确认更新失败才新建，保留旧 Site。 |
| `B_REBIND_AUTHORIZATION_UNAVAILABLE` | 重配并原文重问，不猜改连能力、不复用旧授权。 |
| `B_REBIND_CONFLICT_REQUIRED` / `B_GRANT_EXPIRED` | 重配后按 B2 重问，不复用旧授权。 |
| `B_BINDING_CONFLICT` | 按第 2 节原文展示返回问题/选项，每次重新问；`replace_supported=false` 不改连。 |
| `B_FIELDS_INVALID` | 查字段，不当旧模板；模板版本只认 Site health 明示值。 |
| 缺 Sites 工具/模板交接能力 | 按第 2 节列具体缺口，不假定网页能力、不让用户拖 ZIP。 |
| `SITE_LINE_INVALID` / 配对待定 | 核交接格式和当前等待状态，不贴凭据排错、不把待定说成成功。 |
| ChatGPT 只能读、旧工具或插件找不到 | 回 runbook 第 5 节按本机身份复用/绑定、刷新并做新挑战；不刷新别的同名插件。 |
| 权限管理接口返回 `not_installed` | 按 runbook 第 5 节核同一插件的接口 ID；详情页的 `plugin_asdk_app_…` 仅去掉 `plugin_`。保留现有插件，先纠正 ID，不据此转网页改权限或重复索取授权。 |
| 插件存在但未真调通 | 只算平台配置；按第 6 节验真实读写，不能说这台 Mac 已连上。 |
| 走 Site 第一次测试报 `Tunnel-client has not been seen for 300 seconds` 或 `NOT_FOUND` | 多半选成了旧插件或工具表没刷新：回这个插件的详情页刷新工具，从详情页新开普通对话再试一次；第二次还报才查连接。 |
| Chrome 插件失败 | 以诊断阶段和原因码区分未装、错误用户、NativeHost 未接通和握手超时，核目标用户握手。 |
| `QUARANTINE_*` / 签名失败 | 回 INSTALL 的复制与核验步骤，保留原始错误，不先运行新 App 或叫人手动放行。 |
| `DATA_FORMAT_NEWER` / `DATA_FORMAT_UNSUPPORTED` | 不起后台、不改资料，换兼容版本，不降格式号。 |
| `MIGRATION_TIMEOUT` | 保留资料、退出重开；仍失败带代码联系维护者，半迁移时不起后台。 |
| `ADMIN_SETUP_REQUIRED` | AI 定位管理员功能设置，需要电脑密码/Touch ID 时按 plan-check 交接，不把其他功能都停掉。 |

`CHROME_INSTALL_PROFILE_UNKNOWN`：请用户选目标 Chrome 用户，只核其插件/本机通道；不猜 Default、不动其他用户。
`Cloudflare`、`challenge`、`403`：可能被网络验证拦住，请用户选「改用 OpenAI 通道」；已有配置 `setup switch --route openai`，没有按第 3 节配，不重生密钥排网络。ChatGPT 页面红条/人机验证多半是代理出口，ChatHand 改不了，可换直连。
