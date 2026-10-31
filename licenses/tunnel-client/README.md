# tunnel-client 0.0.15 / darwin-arm64 第三方材料

构建入口 `scripts/bundle-tunnel.mjs` 固定下载官方发布归档：

- https://github.com/openai/tunnel-client/releases/download/v0.0.15/tunnel-client-v0.0.15-darwin-arm64.zip
- SHA-256：`b2cae3aa9df45b4c2fe9b1d700ebacce39f9feb6a6b46b86e6499f9a51bf72ff`

归档中的 `tunnel-client`、`cloudflared` 和依赖清单均与本仓库固定版本对应。两个二进制未执行；从其 Go build information 读取模块、版本、替换关系和 `h1` 校验值。Go 编译器版本均为 `go1.27.0`。

`dependency-sources.json` 逐项记录上游清单的 107 个许可证路径、精确模块版本、Go 官方模块镜像归档 URL、模块校验值，以及原始许可附件的 SHA-256。106 项与二进制内的模块校验值核对；cloudflared 主模块使用发布归档内 `cloudflared-manifest.json` 的 `module_sum`。同一模块的多个包保留各自的清单记录。

`dependencies/` 保留这些固定模块归档中原路径下的 LICENSE、LICENCE、COPYING、NOTICE、PATENTS 文件及其带后缀版本。Go 模块路径的大小写转义沿用官方归档原路径。`quic-go` 和 `urfave/cli` 使用二进制中声明的 fork replacement；未以其他仓库或版本替代。

`go1.27.0/` 包含 Go 固定标签的 LICENSE、PATENTS 与来源哈希。上游清单、根 LICENSE 和 NOTICE 保持原文。构建脚本会将整个 `licenses/` 目录复制入 App；更换 tunnel-client、cloudflared 或 Go 编译器版本时，需要重新核对这些文件。

The original legal files retain their module archive paths. The source manifest records the exact version, archive URL, verified Go module checksum and each file hash. The pinned release binaries were inspected without execution.
