# 第三方组件、许可证与 NOTICE

ChatHand 的应用代码采用根目录 [LICENSE](LICENSE) 中的 MIT 加 Commons Clause 1.0 条款。试用版同时分发下列组件及其运行时；随包许可证和通知全文按组件版本收录在 [`licenses/`](licenses/) 中。软件按各自许可证提供；各组件版权与免责声明以对应全文为准。

| 分发组件 | 版本 / 来源 | 许可证与通知全文 |
| --- | --- | --- |
| Node.js | 24.21.0（构建所用运行时） | [Node.js 与随附第三方许可证](licenses/Node-v24.21.0-LICENSE.txt) |
| npm | 11.19.0（随 Node 运行时提供） | [npm LICENSE](licenses/npm-11.19.0-LICENSE.txt) 与 [随附依赖许可证目录](licenses/npm-11.19.0-dependencies/)、[补充归属说明](licenses/npm-11.19.0-dependencies/README.md) |
| tunnel-client | 0.0.15，macOS arm64 | [Apache-2.0 LICENSE](licenses/tunnel-client/LICENSE.txt)、[NOTICE](licenses/tunnel-client/NOTICE.txt)、[依赖许可证清单](licenses/tunnel-client/tunnel-client-v0.0.15-darwin-arm64-licenses.txt)、[依赖原文](licenses/tunnel-client/dependencies/)、[固定来源与校验](licenses/tunnel-client/dependency-sources.json) |
| cloudflared | 2026.8.2，随 tunnel-client 构建包提供 | 同上；依赖清单见 tunnel-client 附带许可证文件 |
| Go 标准库（tunnel-client / cloudflared） | go1.27.0 | [BSD-3-Clause LICENSE](licenses/tunnel-client/go1.27.0/LICENSE)、[PATENTS](licenses/tunnel-client/go1.27.0/PATENTS)、[固定来源](licenses/tunnel-client/go1.27.0/sources.json) |
| PermissionFlow | 2.11.2 | [MIT LICENSE](licenses/PermissionFlow-v2.11.2-LICENSE.txt) |
| Open Computer Use (OCU) target-only click adaptation | 0.3.6，源码 commit `93b817501e0b9fa04fba155face2630bfcd0322e`，Copyright (c) 2026 Leo | [MIT LICENSE](licenses/OCU-v0.3.6-LICENSE.txt) |
| chrome-devtools-mcp | 1.9.0 | [Apache-2.0 LICENSE](licenses/chrome-devtools-mcp-1.9.0-LICENSE.txt)、[捆绑依赖 NOTICE](licenses/chrome-devtools-mcp-1.9.0-THIRD_PARTY_NOTICES.txt) |
| json-canonicalize | 1.2.0 | [MIT LICENSE](licenses/json-canonicalize-1.2.0-LICENSE.md) |
| playwright-core | 1.63.0 | [Apache-2.0 LICENSE](licenses/playwright-core-1.63.0-LICENSE.txt)、[NOTICE](licenses/playwright-core-1.63.0-NOTICE.txt)、[第三方通知与捆绑文件许可证](licenses/playwright-core-1.63.0-ThirdPartyNotices.txt) 及同目录 `.LICENSE` 文件 |

Node.js 与 npm 的许可证文件对应构建时使用的随包版本。发布包版本变化时，应同步更新这些许可证文件和本清单。tunnel-client 附带清单的 107 项依赖已按固定 Go 模块归档补齐原始许可证、NOTICE 和其他许可附件。归档的 Go 模块校验值与两个二进制内的构建信息对应；cloudflared 主模块与随包 manifest 对应。原始模块路径、版本、来源和文件 SHA-256 记录在 [dependency-sources.json](licenses/tunnel-client/dependency-sources.json)，核对方法见 [说明](licenses/tunnel-client/README.md)。

The 107 entries in the tunnel-client inventory include their original license and notice files from pinned Go module archives, with module checksums verified against the bundled binaries or cloudflared manifest. Go 1.27.0 license and patent notices are included separately.

OCU 的目标进程鼠标事件与 target-only synthetic focus 配方改写在 `native/B2TargetClick.swift` 中，运行于 ChatHand 主原生进程；来源为 [OCU 固定版本源码](https://github.com/iFurySt/open-codex-computer-use/tree/93b817501e0b9fa04fba155face2630bfcd0322e)。原版权、许可及免责声明全文随应用分发。

## 商标与第三方素材

OpenAI、ChatGPT 及其标识属于 OpenAI。ChatHand 是独立项目，名称和标识用于说明所连接的服务；本项目的许可证不授予这些第三方商标的使用权。有关使用条件，请参阅 [OpenAI 品牌指南](https://openai.com/brand/)。

OpenAI, ChatGPT and their marks belong to OpenAI. ChatHand is an independent project; its license does not grant rights to third-party trademarks. See the [OpenAI Brand Guidelines](https://openai.com/brand/).
