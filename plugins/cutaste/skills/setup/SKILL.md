---
name: setup
description: "打开 Cutaste 本地页面、查看自动准备状态或排查本地运行问题；插件已注册 Skill、MCP 与 Hook，无需再安装其他插件。"
---

# 打开和检查 Cutaste

## 插件启动器

需要命令行回退时，从本 Skill 所在目录（`skills/<name>`）向上两级取得插件根目录；路径包含空格时必须引用。使用当前助手对应的入口：Codex 为 `"$PLUGIN_ROOT/scripts/launch.sh" codex <参数>`，Claude Code 为 `"${CLAUDE_PLUGIN_ROOT}/scripts/launch.sh" claude-code <参数>`。若 shell 未提供根目录变量，换成刚取得的绝对路径。不要仅凭 `CLAUDE_PLUGIN_ROOT` 判断宿主，Codex 也可能设置兼容变量。

下文的启动器参数都接在宿主名之后。MCP 与 Hook 已随本插件注册；启动器自动准备确定版本的 npm CLI 基线，并管理兼容更新，无需另装引导、正式插件或全局 CLI。保留 `CUTASTE_INSTALL_DIR`、`CUTASTE_HOME` / `TASTE_HOME`、`CUTASTE_NODE`、`CODEX_HOME` 和 `CLAUDE_CONFIG_DIR`，不替用户改宿主配置。当前已公开核心仍为 Linux x64；本地候选 0.1.1 通用包覆盖 Linux x64、macOS arm64/x64，插件会自行下载、核验和初始化，不需要用户手写 active 记录。候选尚未公开发行；必须以实际下载与本机验收结果为准，不用 --force 绕过平台检查。

本 Skill 用于打开页面或排查问题，不是安装后的必做步骤。插件启用后，MCP 启动或 SessionStart Hook 会触发本地准备。以实际返回状态判断是否可用，不把插件已安装、MCP 已连接或下载已开始当作初始化完成。

1. 优先调用 `cutaste_status`。若返回 preparing，说明固定版本运行程序仍在准备；本次如有独立任务可继续处理，不循环轮询。MCP 不可用时，可用上述启动器追加 `setup --status --json` 查看状态；启动器在缺少 CLI 时会先准备 CLI。
2. 用户要打开页面时，用上述启动器追加 `--no-open`，把返回的真实 URL 交给用户。若准备失败或用户要求重试，用上述启动器追加 `setup --host codex --no-open --json`（Claude Code 改为 `--host claude-code`）；重复执行可恢复进度。此步骤准备本地数据、模板和后台任务，不产生本人投票。
3. 按返回的 problems 排查。Node.js 至少为 22.12.0；指定 `CUTASTE_NODE` 时须为 Node 可执行文件的绝对路径，错误或过旧路径不得悄悄回退。缺少 Node/npm、网络访问失败或目录不可写时报告具体原因，保留用户自定义路径。不要求用户另外安装 Cutaste CLI，也不自动下载 Node 或改动宿主设置。
4. 如需预备截图再给 setup 加 `--browser`；首次截图也会按需准备 Chromium。template queued、browser deferred 和 degraded 必须如实说明；缺 Linux 系统库时报告具体问题，不自动提权安装。
5. 再检查 `cutaste_status` 和宿主显示的接入状态。Codex 可能要求用户在 `/hooks` 中信任当前 Hook 定义；由宿主处理信任，插件和助手不能代签。Claude Code 的相关启用或批准也由宿主处理。

不自动导出偏好到项目文件；用户主动选择的导出使用页面实际提供的入口。页面没有提供的操作不能描述成已完成。
