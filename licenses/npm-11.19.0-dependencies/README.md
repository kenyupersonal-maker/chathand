# npm 11.19.0 随包依赖许可

`packages/` 保留 npm 11.19.0 随包材料，并补充下列固定版本上游原始资料。来源 commit、官方 npm 分发包完整性、上游归档 SHA-256 和附件哈希见 [supplemental-sources.json](supplemental-sources.json)。

- `spdx-exceptions@2.5.0`：补原始 README，保留 Linux Foundation 及其贡献者的版权、CC-BY-3.0 说明和 SPDX 商标说明。[许可链接](https://creativecommons.org/licenses/by/3.0/)。
- `spdx-license-ids@3.0.23`：补原始 README，保留 CC0-1.0 链接。
- `@sigstore/verify@3.1.1`：补该版本源码 commit 的 monorepo 根 Apache-2.0 LICENSE。
- `@npmcli/agent@4.0.2`：固定上游 commit 及随包 metadata 声明 `ISC`，作者字段为 `GitHub Inc.`；原始 `package.json` 已保留。按 Ken 的决定补入 [ISC 标准原文](packages/@npmcli/agent/LICENSE-ISC-supplemental.txt)，版权方取自该版本的 `author` 字段；上游元数据没有版权年份，因此未填写年份。原文模板来自 [Open Source Initiative](https://opensource.org/license/isc)，固定上游出处和补充文件哈希见来源清单。这份文件是标明来源的标准文本补充。测试夹具下的 MIT 许可仍只属于夹具。

npm 自身使用 Artistic-2.0，见 [原始 LICENSE](../npm-11.19.0-LICENSE.txt)。固定源码可从 [npm CLI v11.19.0](https://github.com/npm/cli/tree/v11.19.0) 获取；本构建使用的 npm 副本来自 [Node v24.21.0 官方发行包](https://nodejs.org/dist/v24.21.0/)。本次核对确认 Node 可执行文件、LICENSE 与随包 npm 的 1928 个文件均与该官方 macOS arm64 发行归档一致。

These supplemental files preserve attribution omitted from the bundled package payloads. For `@npmcli/agent@4.0.2`, the standard ISC text is supplied as an explicitly identified supplement, with GitHub Inc. taken from the pinned upstream author metadata. That metadata specifies no copyright year. The original package metadata is preserved; the supplement is not presented as an upstream license file.
