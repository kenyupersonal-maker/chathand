# 一键安装与续接

先按 App 内 `Contents/Resources/codex/INSTALL.md` 核验安装器的身份。再用系统 `/bin/bash` 运行其 `scripts/install-and-start.sh --source "<选中的App>"`。版本高低不作为拦截条件；用户要装哪份就装哪份。

- `--source` 是本次选中的包。新助手可以安装不带本入口的老包，安装器与来源无需是同一份。
- `--target` 可指定实际安装位置；默认 `/Applications/ChatHand.app`，该目录不可写时使用本人的 `~/Applications/ChatHand.app`。已经正常使用的其他位置可直接沿用。
- 命令先用系统工具核验、暂存并清除安装器副本的下载标记，随后才运行随包程序。选中包也会独立核验、暂存；旧 App 退出后才替换文件。
- 不等待业务任务自然完成。退出沿用原生的签名、进程路径和启动时间核对；不按进程名字批量结束。
- `build-provenance.json` 中的 `build_id` 每次构建唯一，中英文安装盘共用。编号相同可以省去复制，同 build 不同编号照装，老包缺编号也照装。
- 正常备份使用 `manual-install/previous.app`；该位置有无法核实的内容时保留它，使用另一个备份位置并返回路径。安装不修改 `data/`、连接、密钥或历史。

## 读结果后继续

`status=ready`、`next_action=continue_setup` 只表示目标 App 已启动且本机自检完成。用返回的 `app_path` 重设 `APP`、`RUNTIME`，读 `skill_path`，在同一配置对话继续原路线。

`doctor.connected=false` 可以是尚未配置；有保存的连接时先恢复连接，不重复创建通道或密钥。`setup_complete=false` 表示 ChatGPT 插件权限、真实读写和桌面完成页还需按 runbook 验证。

`warnings` 中技能登记失败时直接读取返回的随包技能；安装盘暂不能卸载就稍后处理。继续配置，不重复安装。

`incomplete` 按 `phase`、`code` 和 `detail` 查具体原因。已替换后启动失败会尝试恢复旧 App，恢复结果单独返回；未恢复成功时保留原副本和失败副本位置。解决原因后可重跑同一入口。常见问题看 [故障索引](troubleshooting.md)，表中没有的继续调查，避免原样反复重试。
