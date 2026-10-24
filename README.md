# Cutaste 安装入口

通过你的 Codex 或 Claude Code 安装 Cutaste：从 40 道初始题开始构建自己的评测集，并由编程助手调用评测、上下文整理和本地管理页面。

这个公开仓库提供安装说明、安装 Skill，以及两个助手的插件市场清单。完整程序从公开 npm 下载：[cutaste@0.1.0](https://www.npmjs.com/package/cutaste)。核心源码保持闭源。

## 推荐：把这段话发给你的编程助手

```text
请读取下面的 Cutaste 安装 Skill，按说明安装并接入我当前使用的编程助手：
https://raw.githubusercontent.com/ccneed-ai/cutaste/main/plugins/cutaste-install/skills/install-cutaste/SKILL.md

保留我现有的助手配置。如果我指定了安装目录，就使用该目录；否则使用说明中的用户目录。
完成后告诉我安装位置、插件状态、管理页面链接，以及是否还需要新开会话或信任 Hook。
```

助手会检查本机环境、从 npm 下载正式程序，再通过当前助手自己的插件管理器注册插件。无需你手写 MCP 或 Hook 配置，也不要求先全局安装 `cutaste`。

也可以先阅读 [安装 Skill](plugins/cutaste-install/skills/install-cutaste/SKILL.md)。

## 可选：先在助手里安装引导插件

这与上面的链接安装是两种入口，选择一种即可。

### Claude Code

在 Claude Code 会话中依次输入：

```text
/plugin marketplace add ccneed-ai/cutaste
/plugin install cutaste-install@cutaste-install
```

按宿主提示重新加载或新开会话，然后说：

> 请使用 install-cutaste 技能安装 Cutaste 并接入当前助手。

### Codex

让 Codex 执行下面两条命令，或者自己在终端执行：

```sh
codex plugin marketplace add ccneed-ai/cutaste
codex plugin add cutaste-install@cutaste-install
```

新开会话，然后说：

> 请使用 install-cutaste 技能安装 Cutaste 并接入当前助手。

以上命令安装的是轻量引导插件。调用安装 Skill 后，助手才会下载 npm 中的完整程序，并注册正式 Cutaste 插件。这是 Cutaste 自己的插件市场，无需等待官方精选市场收录。

## 装完后如何使用

1. 正式插件注册后，新开助手会话。Codex 若提示 Hook 尚未信任，请在 `/hooks` 中审阅并信任 Cutaste。
2. 对助手说：**“请使用 Cutaste 的 setup 技能完成初始化，并打开管理页面。”**
3. 确认正式插件已启用、4 个 Skill 和 10 个 MCP 工具可发现、初始 40 道题已准备，并拿到实际管理页面链接。
4. 日常在同一个助手里描述要评测的方案，让它使用 Cutaste 的评测工具；页面用于查看评测集、评测报告、偏好和待确认事项。

仅下载完 npm 包，不代表宿主插件和初始化都已完成。需要登录助手、新开会话或信任 Hook 时，安装助手会明确说明。

## 环境与安装位置

- 当前正式包支持 **Linux x64／兼容 WSL**，暂不支持 Windows 原生或 macOS。
- 使用用户本机的 **Node.js >=22.12.0 和 npm**，不需要 Docker，不附带 Node 运行环境。
- 程序安装位置可指定，默认 npm prefix 为 `$HOME/.local/share/cutaste`。实际包在该目录的 `node_modules/cutaste` 下。
- 数据默认放在 `~/.cutaste`，可通过 `CUTASTE_HOME` 指定；保留用户已有的 `CODEX_HOME` 和 `CLAUDE_CONFIG_DIR`。
- 初始题和字体随包提供；截图用的 Chromium 在首次需要时下载。若系统缺依赖，会报告缺项。
- 局部安装不会添加全局命令。需要在终端打开页面时，可执行 `<安装目录>/node_modules/.bin/cutaste`；平时也可直接让助手打开。

## 插件与卸载

- 安装引导插件／市场名为 `cutaste-install`；正式插件为 `cutaste`，正式本地市场名为 `cutaste-local`。
- 安装到当前使用的助手；需要两边都用时，分别在 Codex 和 Claude Code 中完成接入，可复用同一份 npm 程序。
- 正式安装后可以卸载引导插件。卸载引导不会移除正式插件或数据。
- 完整卸载需分别注销宿主插件和卸载 npm 包；默认保留用户数据。可让助手按安装 Skill 处理。

公开安装资料不改变完整程序的闭源许可。程序发行条款见 npm 包内 LICENSE 和 NOTICE。
