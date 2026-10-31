```text
进入 Work 模式，帮我安装 ChatHand 并连上 ChatGPT。安装包在「下载」文件夹里，步骤写在安装包里的 ChatHand.app/Contents/Resources/codex/INSTALL.md。
```

# ChatHand 1.0.0-beta.2

下载：`ChatHand-1.0.0-beta.2-arm64.dmg`

SHA-256：随本地发布准备目录中的 SHA256SUMS 核对。

适用于 Apple 芯片 Mac、macOS 14 或更新版本。首次打开需要放行一次：双击安装盘里的「第一次打开」，照页面操作（交给 Codex 装的话它会处理）。浏览器扩展和桌面控制为可选功能。

## 本版本变化

- 版本 1.0.0-beta.2，构建号 1010。
- 提供首页、任务、连接、设置和引导流程。
- Codex 可按随包离线说明完成安装；已安装时可直接继续配置，无需保留 DMG。
- 默认只在工作区内操作；浏览器及桌面能力按需开启。
- 安装磁盘提供「让 Codex 来装」HTML 入口、手动拖放及「第一次打开」页面；浏览器询问是否打开 ChatGPT 时点打开，ChatGPT 填好安装句后按回车，它会自动转到「工作」完成安装。使用精修图标和适配 Retina 的双分辨率背景。
- 自己装：把 ChatHand 拖进「应用程序」，再双击安装盘里的「第一次打开」，照页面复制命令，到终端粘贴、回车，ChatHand 会自己打开。
- 同一 ChatGPT 对话的任务自动归组，可共用一次保存的对话链接；满足唯一生成标签条件时自动关联。
- 配置助手合并为一个打开并复制按钮。

## 已知限制

- 朋友试用版，仅提供 Apple 芯片 Mac 版本。
- 使用自签名证书，尚未通过 Apple 公证；可交给 Codex 按随包说明安装。
- 首次账号登录、系统权限和 ChatGPT 应用授权由 macOS 和 OpenAI 把关，其余由 ChatGPT 来做。
- ChatGPT 中请先输入 @ 选择 ChatHand，再粘贴试用句发送。
