---
name: install-cutaste
description: 安装或修复 Cutaste 0.1.0：由当前编程助手检查环境、从公开 npm 下载程序、登记正式插件并验证初始化。用于用户要求安装 Cutaste；已安装后的评测和上下文整理使用正式插件。
---

# 安装 Cutaste

把 Cutaste 安装到用户选定的位置，并接入用户正在使用的 Codex 或 Claude Code。这份引导可作为轻插件 Skill 使用，也可直接从链接阅读。它自身不运行 Hook、MCP、模型或安装脚本；按用户的安装请求执行下列步骤。

## 检查环境和位置

- 当前正式包仅支持 Linux x64（含兼容 WSL），需要本机 Node.js >=22.12.0 与 npm。检查 `node --version`、`npm --version` 和系统/架构。其他平台停止并说明，不把 WSL 等同 Windows 原生支持。不需要 Docker，也不随包下载 Node。
- 选择实际承载当前会话的助手，不因 PATH 中同时有两个 CLI 就同时安装。宿主不明确时只问这一项。已验宿主为 Codex 0.162.1、Claude Code 2.1.283；更早版本先检查其 `plugin` 命令，不能臆造兼容范围。
- 保留用户已有 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`CUTASTE_HOME` 和 `CUTASTE_NODE`；安装插件与后续启动必须使用同一套宿主环境。读取配置时不输出凭据。
- 优先使用用户指定的包目录或可用的同版本现有安装；新安装默认放在 `$HOME/.local/share/cutaste`，这是 npm 包目录，数据默认仍在 `~/.cutaste`。检查目录占用和写权限，不覆盖其他项目、不要求全局安装或自动 sudo。

## 获取正式程序

使用公开 npm 的固定版本 `cutaste@0.1.0`，不克隆私有源码，不使用 `latest` 代替指定版本。安装公开包无需 npm、GitHub 或 Hugging Face 账号。

用户未指定其他目录时，可在同一 shell 中执行：

```sh
cutaste_install_dir="$HOME/.local/share/cutaste"
npm install --prefix "$cutaste_install_dir" --registry=https://registry.npmjs.org/ --no-audit --no-fund cutaste@0.1.0
```

用户指定目录时将变量设为其实际绝对路径；后续调用仍须重新使用这个实际路径，不依赖工具之间保留 shell 变量。若复用全局安装，用 `npm root -g` 找到包目录。下载失败时报告实际错误；不切换未知镜像或无限重试。

正式包的根目录是 `<安装目录>/node_modules/cutaste`。检查其版本为 0.1.0；使用 `node "<包根目录>/bin/cutaste.mjs" --version`、`doctor --json`、`tools list` 验证可启动和 10 个工具。doctor 可指出尚未接入助手或缺截图依赖，应继续相应步骤；不能据此虚报全部就绪。程序说明见 https://www.npmjs.com/package/cutaste 。

## 登记当前助手的正式插件

只执行与当前宿主对应的一组命令，替换下面的包根目录。先通过宿主的 `plugin marketplace list` 和 `plugin list` 核对已登记的来源与安装状态；已有同版本、同路径的有效登记可跳过。通过宿主自己的插件管理器操作，保留已有配置和认证，不手工覆盖 MCP/Hook 配置文件。

Codex：

```sh
codex plugin marketplace add "<包根目录>/plugins/codex"
codex plugin add cutaste@cutaste-local
codex plugin list --json
```

Claude Code：

```sh
claude plugin marketplace add "<包根目录>/plugins/claude-code"
claude plugin install cutaste@cutaste-local
claude plugin list --json
```

这里的正式市场名是 `cutaste-local`，不要与安装引导的 `cutaste-install` 混用。若同名市场已存在且指向别处，先核对来源，保留现有可用安装，不删除或替换不明来源配置。用户授权的升级/重装才能使用宿主支持的更新方式。

## 初始化与交付

插件注册后需要新开助手会话；不能声称当前会话已热加载 MCP。Codex 如要求信任 Hook，请用户在 `/hooks` 中审阅并信任 Cutaste，不替用户写信任记录。Claude Code 按宿主实际提示重新加载或新开会话。

新会话中使用正式 Cutaste 的 `setup` Skill，或让用户说“请使用 Cutaste 的 setup 技能完成初始化并打开管理页面”。它通过已安装插件自己的程序准备数据和页面。首次正常 SessionStart 也会尝试自动准备；setup 是显式验证和修复入口。

验收应确认：正式插件已启用，4 个 Skill 与 10 个 MCP 工具可发现，`cutaste_status` 可调用，初始 40 题已准备，返回真实页面链接。只完成文件下载时报告“程序已下载”；等待新会话/Hook信任时说明所欠步骤，不能提前报告整个接入成功。

初始题和字体已随包提供；Chromium 在首次截图时按需下载。若缺系统共享库，报告缺项，不擅自提权安装。正常推理需要用户的助手登录和当前模型可用；安装验收不启动大型评测，不替用户登录或更换模型。

完成后报告包安装位置、数据位置、宿主插件状态、页面链接与剩余问题。使用局部 npm prefix 不会自动提供全局 `cutaste` 命令；终端可调用 `<安装目录>/node_modules/.bin/cutaste`，也可让助手从正式插件打开页面。无需让用户为使用插件再全局安装一次。

轻量安装引导与正式插件互相独立，完成后可卸载引导插件。保留正式 npm 安装目录供后续维护；卸载 npm 包不会注销宿主中的正式插件，若用户要求完整卸载，应分别通过宿主插件管理器和 npm 处理，默认保留用户数据。偏好导出可选，不改用户项目文件。
