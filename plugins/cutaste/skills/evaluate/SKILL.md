---
name: evaluate
description: "用 Cutaste 当前题库试跑或比较一个及多个目标，由当前编程助手执行目标、提交静态产物并解读真实评测结果。"
---

# 评测与报告

## 插件启动器

需要命令行回退时，从本 Skill 所在目录（`skills/<name>`）向上两级取得插件根目录；路径包含空格时必须引用。使用当前助手对应的入口：Codex 为 `"$PLUGIN_ROOT/scripts/launch.sh" codex <参数>`，Claude Code 为 `"${CLAUDE_PLUGIN_ROOT}/scripts/launch.sh" claude-code <参数>`。若 shell 未提供根目录变量，换成刚取得的绝对路径。不要仅凭 `CLAUDE_PLUGIN_ROOT` 判断宿主，Codex 也可能设置兼容变量。

下文的启动器参数都接在宿主名之后。MCP 与 Hook 已随本插件注册；启动器自动准备并复用固定版本的 npm CLI，无需另装引导、正式插件或全局 CLI。保留 `CUTASTE_INSTALL_DIR`、`CUTASTE_HOME` / `TASTE_HOME`、`CUTASTE_NODE`、`CODEX_HOME` 和 `CLAUDE_CONFIG_DIR`，不替用户改宿主配置。当前正式 npm 运行程序支持 Linux x64；其他平台尚未验收，不要声称已经支持。


Cutaste 提供题、产物目录、检查和报告；当前编程助手负责理解场景、配置并运行被测对象。单次试跑和多目标比较走同一协议，不需要用户再选择公共或个人题库。

1. 用 `cutaste_status` 检查状态，`cutaste_benchmark` 发现可披露任务。它返回可直接使用的 scenario、familyId 和版本；需要时用 offset/limit 翻页。常规正式就绪题默认全部可评，不再自动按 20/20 留出一半；候选、退役、作废和明确独立验证题仍排除。没有符合场景的题就说明缺口，不自行造题或读取专项验证题。
2. 用 `cutaste_eval_start` 提交 targets（每项含 id、实际配置 fingerprint），明确选题范围：默认领取当前全部可披露就绪题，可配 scenario 限定场景；只有明确需要抽样时才传 limit。指定 families 时完整领取该列表，不传 limit，较小 limit 会报错；selection:"all-disclosed" 可显式声明全量，但不能再配 families/limit。selection:"sample" 必须配 limit 或 families，系统不会默认只跑 5 题。不要用固定演示清单代替用户要求的完整评测。单次试跑用一个目标、limit:1；多个目标领取同一批题。先核对返回的 coverage：available 是当前场景下可披露就绪题数，selected 是实际题数，tickets 是题数×目标数。单 session 最多 100 题、400 票，超限请向用户说明并明确缩小范围，不能悄悄拆成多次评测。数量以实时目录和 coverage 为准，不把候选或明确独立验证题补入。领取票据不等于已运行，必须等报告逐票完成才能声称全量评测完成。不传 pack。不要以目标名替代实际模型、skill、规则或运行配置的指纹；只记录已知信息。可得来源 sessionId 或项目绝对路径时传 context，不能猜 ID 或把插件目录当用户项目。
3. 按每张票据的 instruction 执行对应目标，将静态文件保存在分配的 outputDirectory。用 `cutaste_evaluate_artifact` 提交 ticket、directory、producer（与目标 id 一致）。记录真实命令和产物；执行受阻时仍用该工具提交 ticket、producer、executionFailure:{kind:"auth"|"quota"|"timeout"|"execution",summary:"简短说明"}，此时不要传 directory。summary 不包含凭据、一次性代码或原始 stderr。该记录标为助手上报的阻塞，不产生质量分；修复后可用同一票据提交 directory 恢复，已完成产物不能被失败记录覆盖。
4. 用 `cutaste_eval_report` 读取 session 汇总；传 evaluation 可读单票，同时给 session 和 evaluation 时会检查归属。未完成时准确报告 pending/blocked/failed/invalidated，不把领到题当作已经运行。恢复既有评测先读取 session 报告中的 resumableTasks，按其原始目录和 instruction 继续；只恢复仍可披露且规则未变的票据，不另建一批题来冒充同一次。助手决定是否继续，不自动循环重试。
5. 若报告提供 visualAssessmentRequest，用当前会话模型查看请求列出的实际截图，严格按冻结 rubric.criteria 的全部维度、评分锚点和 replySchema 评分；不假定永远是六维。用 cutaste_evaluate_artifact 提交 visualJudgment（requestHash、criteria、judge、rawReplyHash），不要同时提交 directory。模型/版本只填确知信息；未看图或无法打分就保留未评分。不同 rubricHash 的结果不可混成同一排名，模型分数不是本人投票。
6. 若报告同时提供 requirementAssessmentRequest，按冻结的 points 查看同一组截图，用 requirementJudgment 提交全部需求点的 met/violated/missing/n/a、具体截图证据、judge 和原始回答哈希。不能从静态截图证明的交互或后端需求必须为 n/a。此步骤不改程序底线，也不算本人反馈。
7. 用户要停止时，停止你自己启动的目标进程，并调用 `cutaste_eval_cancel`。该工具只停止 Cutaste 收件，不会替你杀掉外部程序。

自动程序检查、缺席的模型判断和本人反馈分开说明。当前协议是可披露任务的产物评测；静态截图不能证明提交、支付、后端或所有交互功能正常。没有模型打分或本人盲选就标未运行，不宣布个人审美赢家。不同产物要新票据；同产物的基础设施失败可按返回信息修复后重试，不能无限重试。

报告包含本地页面路径，需要时用上述启动器追加 `--no-open` 启动页面并给用户链接。MCP 不可用时，用同一启动器 `tools list` / `tools call <name> --input '<JSON>'`，不依赖全局 CLI。初始化失败先使用 setup，不另走旧 run/compare/new 命令，也不增加额度确认步骤。
