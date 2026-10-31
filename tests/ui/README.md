# ChatHand 界面自检

`npm --prefix tests/ui test` 运行 1012 界面自检。只使用已有 `playwright-core` 和本机 Chrome 的无头模式，不下载依赖或浏览器，不操作桌面和真实配置。

检查使用仓库 `ui/` 的实际页面，随机端口假服务提供流、向导、权限和工作量状态。UI-1 的 stream/continuity/clocks/actions/matrix、UI-2 的 behavior/races/accessibility/boundaries/matrix、UI-V 的 behavior/matrix/long/final 已迁到 `1012/checks/`。运行不读取忽略的 `docs/plans` 或旧 artifact 的 before-source。

覆盖事件流鉴权/分帧/重连/30秒兜底、焦点和动画连续性、权限确认、向导第5/6步、例句按钮、两种主题和窗口、1.6倍字体与文字、工作量十状态40格、百分比边界、后端额度/价格、清零失败保留数字、安装页验证以及皮肤机制。几何和对比度阈值保持原检查；历史字节比较保留在原设计审查证据中。原有22处业务URL不作为远程加载误报。

真实服务冒烟在 `tests/v1/1012-main-service-ui.test.mjs`，用临时状态目录和隔离依赖启动真实服务，检查未配置状态的设置方式自动出现、客户端模块、脚本/样式200、控制台零错误以及两皮肤×浅深。配合既有静态资产白名单和管理HTTP清零失败合同；不代表 WKWebView、账号或真实浏览器/桌面验收。

每轮日志/JSON/截图默认保存在 `~/Developer/ChatHand-builds.noindex/1012-validation/sa6/run-*/`；可用 `CHATHAND_BUILDS_ROOT` 更换产物根目录，或用 `CHATHAND_UI_OUTPUT` 指定独立证据目录。`node tests/ui/1012/run.js --only=stream,real-main` 可定点检查；`SKIN` 不改变该矩阵的产品场景。所有剪贴板和原生动作只走浏览器内 fake，服务和浏览器由检查清理。

旧 1011 检查保留在 `harness/`，可用 `npm --prefix tests/ui run test:legacy` 独立运行；常规入口采用 1012 的新行为合同。
