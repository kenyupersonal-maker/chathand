# 连接页、配置等待与改连接口

配置步骤仍按 [runbook](runbook.md) 用随包 setup 命令。本页解释连接页与诊断返回；带 Owner+当前窗口认证的动作只由 ChatHand 窗口发起，AI 不伪造窗口认证或绕开人工删除确认。

## 实际选择与配置目标

`site_b.selected` 是实际执行路线；`setup_route` 是正在配置/修复的目标，两者可不同。有效 `site_b.selected` 优先成为 setup 的 `selected_route`；缺失/无效时才回退到 `setup_route`（包括 none），再默认 openai。不能用目标覆盖已选路线或据此报告连接成功。

`site_b.routes` 各自回 configured/state/health_fresh/reason，Site 还有 origin。两条都未配置时 selected 仍可为 openai，须结合 configured 判断。repair 先 doctor，只修点名路线；add 保留另一条，真测过才切，不把交接提示返回当已完成。

## 改用与删除

- `/api/connection/use {route}`：Owner+当前UI认证，先拉起并验证目标，总等最多6秒；成功 `{ok:true,selected,changed,revision,...切换元数据}`；目标失败 `{ok:false,error_code,selected}`，原路线不动，不续 setup_activity。原参数/认证错误仍用 HTTP 错误。AI 明确获准换路仍用 `setup switch --route openai|site`。
- `/api/connection/remove {route}`：同认证且先由窗口确认。OpenAI先停再清本机连接；Site先撤本机登记，最多等10秒，未确认也清本机凭据/设置，不删除账号里的Site。成功 `{ok:true,selected}`；仅Site带 `revoke:CONFIRMED|UNCONFIRMED|SKIPPED`。删active才接健康备用，无备用回默认未配置状态；用户暂停、权限或升级阻塞不被后台回退解除。

## 等待与真实进展

`setup_activity` 回 active/last_at/last_command/route/seen_at，可有 finished_at。seen_at 是助手命令最近时间或 null，不算进度；doctor、status、交接、换路不点亮/续期，只有已接受的连接、配对等真实进展才记。

`site_b.enrollment_watch` 活跃时回 watching:true/watch_id/expires_at；截止为最后真实Site进展后15分钟且不超过intent期限，以返回时间为准。切走、终止错误或到点会停，回 watching:false/stopped_id/stopped_reason；重启保留停止标记和 pairing.phase=failed/error_code，迟到回包不能拉回Site。只读状态不创建配对intent，明确重新开始才清失败。

## 改连授权与升级失败

按runbook原文展示当前问题/选项，只用本次新回答和同Site的 `replacement.authorization_url`。`replacement.next_action=resume_pairing` 时重跑同一 `setup site-replace --grant-from-clipboard`，CLI先核状态并恢复原交易，不读/清剪贴板、不取新grant。

只有当前更新已证实终局失败，才能经受信Owner管理接口记录 `/api/site-b/replacement-upgrade-failure`，精确字段为 origin/question_id/phase:'failed'/error_code/version_id/deployment_id；绑定当前问题，返回新问题及 replace_supported:false，再照新选项问。超时、丢响应、unknown或远端自报不作失败收据，不重开bootstrap。缺受信接口就保留现状、报告缺口，不手工改本地状态。
