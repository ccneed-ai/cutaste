# Cutaste

在 Codex 或 Claude Code 中安装一个插件，使用随上下文演化的评测集、评测工具和本地管理页面。评测集从 40 道初始题开始。

**插件包含 4 个 Skill、MCP 与 Hooks，并自动准备所需的 Cutaste 程序。无需复制安装提示词，无需先全局安装 CLI，也无需手写 MCP 配置。**

## 安装

当前发行包已在 **Linux x64** 验收，需要本机 **Node.js >=22.12.0、npm 和 Git**。不需要 Docker，不下载 Node；WSL 尚未单独验收，暂不支持 Windows 原生或 macOS。

### Claude Code

在 Claude Code 会话中依次输入：

```text
/plugin marketplace add ccneed-ai/cutaste
/plugin install cutaste@cutaste-install
```

按插件面板选择安装范围并安装，然后按提示重新加载或新开会话。`/plugin` 可以查看插件状态；`/mcp` 可以检查 Cutaste 的连接。

### Codex

通过 Codex 自带的插件管理命令添加市场并安装：

```sh
codex plugin marketplace add ccneed-ai/cutaste
codex plugin add cutaste@cutaste-install
```

也可以只执行第一条，再在 Codex 会话输入 `/plugins`，选择 **Cutaste** 安装。安装后新开会话。

Codex 如提示 Hooks 尚未信任，在 `/hooks` 中审阅并信任 Cutaste。这个授权由宿主管理；MCP 自动准备程序不依赖安装 Skill。

## 安装后会自动发生什么

1. 助手加载插件时，注册 `setup`、`cutaste`、`evaluate`、`alignment` 四个 Skill，以及 MCP 和对应助手的 Hooks。
2. MCP 启动或首次会话钩子运行时，自动从公开 npm 下载固定版本 `cutaste@0.1.0`。正式包约 125 MB，首次需要等待下载；有效安装会直接复用。
3. 准备过程中，MCP 保持连接，并如实报告准备状态。后台自动初始化数据、导入 40 道初始题，并启动本地页面服务；不会擅自弹出浏览器。完成后接通正式工具，无需再运行安装 Skill。
4. 之后直接对助手说“打开 Cutaste 管理页面”或描述要评测的方案。`setup` 保留为检查、打开页面和修复入口，不是必做的安装步骤。

添加 marketplace 只是添加插件来源，仍须选择并安装其中的 **Cutaste**。插件安装成功也不代表网络下载已经完成；缺 Node、下载失败或宿主需要授权时，会报告实际问题。

## 包含哪些能力

| 部分 | 用途 |
| --- | --- |
| 4 个 Skill | 初始化与排查、日常使用、评测、处理需要用户对齐的事项 |
| 10 个 MCP 工具 | 状态、评测集、偏好、上下文任务、对齐事项，以及评测的发起、提交、报告和取消 |
| Hooks | 在当前助手的会话事件中采集上下文并提示待处理事项 |
| 本地程序 | 管理评测集、数据、截图、评分与管理页面；推理交给用户正在使用的助手 |

Skill 注册后由助手按任务使用，不会因为安装了插件就自动执行所有 Skill。

## 目录与依赖

- 程序默认放在 `$HOME/.local/share/cutaste`，可在启动助手前设置 `CUTASTE_INSTALL_DIR` 指定其他目录；程序位于该目录的 `node_modules/cutaste`。
- 数据默认放在 `~/.cutaste`，可通过 `CUTASTE_HOME` 指定。已有 `CODEX_HOME`、`CLAUDE_CONFIG_DIR` 保持不变。
- Node 默认从本机 PATH 查找；也可设置 `CUTASTE_NODE` 为本机 Node 的绝对路径。
- 初始题和字体随正式包提供；截图用的 Chromium 在首次需要时下载。缺系统依赖时会报告缺项。
- 局部安装不会添加全局 `cutaste` 命令。需要终端入口时可运行 `<安装目录>/node_modules/.bin/cutaste`。
- 两个助手都要使用时，分别安装插件，可以共享同一程序目录。

## 更新、卸载与备用入口

通过宿主的插件管理器更新或卸载 Cutaste。卸载插件会停用该宿主中的接入，默认保留本地程序与数据。

此前的 `cutaste-install` 仅是安装引导插件；现在安装的是 **cutaste**。已经装过引导的用户可以卸载引导，再按上面的方式安装 Cutaste。若已有 `cutaste@cutaste-local` 正式插件，切换时只保留一份启用，避免重复采集。

需要人工排查或特殊安装时，旧 [安装 Skill](plugins/cutaste-install/skills/install-cutaste/SKILL.md) 仍可阅读，但不是默认入口。

## 发行范围

这个仓库公开薄启动器、插件清单和 Skill。完整程序通过 [npm cutaste](https://www.npmjs.com/package/cutaste) 发行，核心源码保持闭源，发行条款见 npm 包内 LICENSE 与 NOTICE。

这是 Cutaste 自己的插件市场，不代表已上架宿主的官方精选目录。

官方安装机制：[Claude Code](https://code.claude.com/docs/en/discover-plugins)、[Codex 插件](https://learn.chatgpt.com/docs/plugins)、[Codex 市场与插件封装](https://developers.openai.com/plugins/build/plugins)。
