# 上游同步提示词（把整个文件交给 agent 执行）

你现在的任务：把 `upstream/main` 的最新提交同步进本仓库（`prime-agent-bun`），保持本 fork 是「上游之上的薄补丁序列」，并确保 Bun 内核的产品语义不被破坏。

动手前先读：

- `AGENTS.md`（仓库硬性规则：身份、`Co-authored-by`、边界面、测试与性能要求）
- `docs/fork/kernel-ownership.md`（本 fork 拥有的文件集；冲突只会落在这里）
- `docs/fork/upstream-sync.md`（移植台账：Port / Not applicable / Defer）

## 0. 环境与前置

```bash
cd /Users/blod/ai/repo/prime-agent-bun
git status --short          # 必须干净；有改动先提交或说明
git remote -v               # 没有 upstream 就加：
# git remote add upstream git@github.com:PrimeIntellect-ai/prime-agent.git
git fetch upstream main
BASE=$(git merge-base HEAD upstream/main)
echo "behind: $(git rev-list --count HEAD..upstream/main)  ahead: $(git rev-list --count upstream/main..HEAD)"
git branch backup/pre-sync-$(date +%Y%m%d-%H%M%S)
```

## 1. 分类上游提交

```bash
python3 scripts/fork/classify_upstream.py --range "$BASE"..upstream/main
```

- `clean`：机械合并即可。
- 触及 kernel surface：逐条给处置（Port / Not applicable / Defer），写进 `docs/fork/upstream-sync.md` 的 Ledger。
- 分类器是**提交级保守判定**；实际冲突取决于双方是否都改过同一文件，`git merge` 会告诉真相。

## 2. 合并（用 merge，不要 rebase 已推送的 main）

```bash
git merge upstream/main
```

冲突预期只出现在声明表面。解决原则：

- `crates/pa-core/src/kernel/manager/startup.rs`：保留 fork 的 launcher seam（`if options.python.is_none() && selected() { bun }`），Python 分支完整吸收上游改动（如 `-P -s`、`ensure_kernel_python_for_project`、env 类型变化）。**不要因为冲突就丢掉上游的安全修复。**
- `README.md` / docs：保留 Bun 内核措辞，采纳上游新的语义（例如「项目内技能不自动执行代码」）。
- 通用：先理解上游意图，再把与运行时相关的差异按 Bun 重新落地；上游的 bug fix / 安全修复必须保留，不能整段回退。
- 冲突文件不在 `docs/fork/kernel-ownership.md` 里：要么把改动挪回表面内，要么把该文件加进 `scripts/fork/classify_upstream.py` + 文档，同一次提交里说明原因。

## 3. kernel 表面提交的语义移植（合并不等于完成）

逐条检查上游是否引入了需要 Bun runtime 跟进的语义，至少覆盖：

- 协议 v3 / 帧上限 / `rlm` API 新增或签名变更（`prime-agent-bun-runtime/src/*.ts`，对照 `KERNEL-API.md`）
- snapshot/restore、同路径 reopen 复用最终快照、rebootstrap memo
- 启动安全边界：项目内代码（Python 或 JS 技能/配置）不得在 session 启动时自动执行
- skills（`skills/**`、`crates/pa-core/src/skills/**`）与 websearch provider 选择（JS 侧目前仍是 Serper-only，属已知 Defer）
- 工具名分发：`bun_repl` / `python_repl` 的判定必须走 `pa_types::ai::is_kernel_tool_name`（TUI 卡片分发、会话树行、ACP tool kind 与标题、kernel 回执、compaction diff）
- prompt 层：`prompts/layers/*.md`、`kernel-bun` 层、自定义 system prompt 之后仍追加 runtime 层的逻辑、harness digest、goal/MCP 文案
- settings 新键（保持 `pythonCellTimeoutMs` 等历史标识符不变）

更新 `docs/fork/upstream-sync.md` 的 Ledger 行（upstream 提交号 / 处置 / fork 落点 / 备注）。

## 4. 验证（缺一不可）

```bash
cargo fmt --all
cargo check -p pa-core -p pa-types -p pa-tui -p pa-daemon --all-targets
./test/verify-all.sh --with-package
python3 scripts/fork/check_ownership.py
python3 scripts/fork/protocol_drift.py --ref upstream/main
```

- `verify-all` 必须 18/18；informational 的 pa-core / pa-daemon 已知环境失败可以照旧，但不得新增失败。
- 改了打包 / 传输 / 内核接缝时，额外跑一次真实会话冒烟（provider 选便宜的），并记录 `PI_REQUEST_TIMING=1` 的首字节时间。
- 改了 provider 配置相关代码时，用死代理验证 `bypassProxy` 仍生效：
  `http_proxy=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 NO_PROXY= … prime-agent --provider <配置了 bypassProxy 的> -p "PING"` 应成功，去掉该字段应报 `Connection error.`。

## 5. 提交与推送

- 一个逻辑变更一个提交；消息用祈使句，说明「上游做了什么 + 我们怎么适配」。
- 不设置 git 身份、不加 `Co-authored-by`（仓库 AGENTS.md 硬性要求）。
- 只推 `origin`（fork），不推 upstream；不要打普通 `v*` 标签（会触发上游 R2 发布流程），fork 发布用 `fork-v*`。
- 推送前确认工作区干净，`.changes/` 片段已更新。

## 6. 最后给我一份报告

用表格列出：同步范围、clean / kernel 提交数、冲突文件与解决方式、Ledger 新增行、验证结果（逐项 PASS/FAIL）、提交 hash、以及仍未完成的 Defer 项。

## 硬性约束

- 不删除 `prime-agent-runtime/`（保留上游 Python runtime 便于合并；产品层仍然是 Bun-only、无回退）。
- 不把任何真实使用的域名、API key、provider 别名写进代码 / 测试 / 文档；需要 fixture 时用 `example.com` 等占位。
- 不改变产品语义：`prime-agent` 永远 Bun 内核；wire 标识符（`python_repl`、`<python_import>`、`[python-state]`、`<ipython_kernel_reset>`、`pythonCellTimeoutMs`）保持不变。
- 不把我们的 diff 扩到声明表面之外；需要扩展就先更新 `classify_upstream.py` 和 `kernel-ownership.md`。
- 遇到无法判断的冲突：停下来说明两个版本的意图和你的建议，不要猜。
