# 这个仓库包含什么

这里是 Cutaste 面向用户的插件与安装入口。CLI 从 [npm cutaste](https://www.npmjs.com/package/cutaste) 自动取得；完整应用核心源码不在这个仓库。

```text
.agents/plugins/marketplace.json  Codex 插件市场
.claude-plugin/marketplace.json   Claude Code 插件市场
plugins/cutaste/
  .codex-plugin/plugin.json      Codex 元数据
  .claude-plugin/plugin.json     Claude Code 元数据
  skills/                       使用、评测、对齐和修复说明
  mcp.json / .mcp.json           两个宿主的 MCP 启动配置
  hooks/                        宿主会话事件配置
  scripts/                      下载、版本选择、自动更新与转发的薄启动器
README.md                       安装、更新、目录与依赖说明
```

插件的 Skill 和配置按宿主机制可读。完整 CLI 公开下载但保持闭源，发行条款在 npm 包内；本仓库公开接入层不表示应用核心开源。

接入结构参考 [Codex 官方插件示例](https://github.com/openai/plugins)、[Claude Code 官方插件目录](https://github.com/anthropics/claude-plugins-official) 和 [Supermemory 插件](https://github.com/supermemoryai/claude-supermemory)。Cutaste 使用本地程序和本地数据，其运行行为以本仓库安装说明为准。

安装见 [README](README.md)。旧 plugins/cutaste-install 仅为备用人工引导，不是默认安装步骤。

## 候选自动更新边界

0.2.2 目前是未发布候选。公开启动器负责解析 npm latest、下载和校验稳定版、记录活动版本、等待安全切换及保留旧版；不包含评测、演化、打分等核心业务。运行程序继续通过 npm 发行，不把私库核心源码复制到公开仓库。

CLI 的兼容更新不要求同步更新插件。Skill、hook、宿主权限或插件协议的变更仍通过宿主插件管理器安装，不由后台更新器改写用户的 Codex 或 Claude Code 配置。
