# Kernel ownership: what this fork owns

This fork replaces the kernel runtime. Everything else tracks upstream Prime
Agent mechanically. The file set below is the **conflict surface**: an upstream
commit touching it needs a human disposition; a commit touching nothing here is
safe to cherry-pick or rebase.

`scripts/fork/classify_upstream.py` enforces this classification, and
`scripts/fork/check_ownership.py` (see below) keeps the fork's own diff inside
the declared set.

## Fork-owned (the kernel surface)

### Runtime payload

| Path | Why the fork owns it |
| --- | --- |
| `prime-agent-bun-runtime/**` | The Bun runtime itself (new in this fork) |
| `prime-agent-runtime/**` | Kept, unmodified, as the upstream Python runtime — see "Retained upstream assets" |

### Rust kernel seam

| Path | Why the fork owns it |
| --- | --- |
| `crates/pa-core/src/kernel/bun_runtime.rs` | Runtime selection, Bun resolution, version gate (new) |
| `crates/pa-core/src/kernel/mod.rs` | Module registration + `KernelLauncher` re-export |
| `crates/pa-core/src/kernel/shared.rs` | The `KernelLauncher` type (additive) |
| `crates/pa-core/src/kernel/manager/startup.rs` | Launch descriptor consumption (the only behavioral seam) |
| `crates/pa-core/src/kernel/provisioner.rs` | Bootstrap-cell selection by runtime |
| `crates/pa-cli/src/main.rs` | The composition root forces the product runtime (`apply_product_default`), one line |
| `crates/pa-core/src/kernel/bootstrap/venv/**` | Python-only provisioning; upstream may change it freely |
| `crates/pa-core/src/tools/ipython.rs`, `crates/pa-core/src/tools/ipython/**` | The model-facing tool definition, result text, busy-kernel copy |

### Model-facing surface (divergence phase 5)

| Path | Why the fork owns it |
| --- | --- |
| `crates/pa-core/src/prompts/layers/core.md` | Documents the `rlm` API and the REPL language |
| `crates/pa-core/src/prompts/layers/kernel-bun.md` | The Bun runtime's language layer (gated) |
| `crates/pa-core/src/prompts/layers.rs`, `system_prompt.rs` | Layer registration + the gated insertion + the runtime-aware packages line |
| `crates/pa-core/src/kernel/vocabulary.rs` | The words model-facing notices use for the running kernel (new) |
| `crates/pa-types/src/kernel_runtime.rs` | Shared runtime-selection vocabulary, so `pa-tui` can label cells (new) |
| `crates/pa-types/src/ai/mod.rs` | The kernel tool's name (`bun_repl` / `python_repl`) and the alias set |
| `crates/pa-ai/src/utils_inner/http.rs`, `crates/pa-ai/src/lib.rs` | The proxy-bypass transport clients and their host registry |
| `crates/pa-core/src/models/{custom,registry}.rs` | The `bypassProxy` provider field (`models.json`) and its registration |
| `crates/pa-core/src/session_engine/{tool_bridge,engine}.rs`, `engine/tests.rs` | Tool dispatch follows the active tool name |
| `crates/pa-cli/src/prompt_command.rs` | The assembled-prompt tool list |
| `crates/pa-daemon/src/acp/wire_events.rs` | The ACP tool-call title follows the kernel |
| `crates/pa-core/src/session_engine/{ipython_state,state_restore_notice,skills_unavailable_notice,compaction,agent_messaging}.rs` | Notice prose follows the runtime (tags preserved) |
| `crates/pa-tui/src/tool_card/ipython.rs` | The cell card's language label follows the runtime |
| `crates/pa-tui/src/tool_card/mod.rs` | Kernel-card dispatch accepts `bun_repl` (a miss falls back to the raw generic card) |
| `crates/pa-tui/src/tree_display.rs`, `session_ui/apply.rs` | Kernel-cell rows and their telemetry accept `bun_repl` |
| `crates/pa-daemon/src/acp/types.rs` | The ACP tool kind treats `bun_repl` as Execute |
| `crates/pa-core/src/session_engine/{late_sent_messages,compaction_utils}.rs` | Kernel receipt patching and edit-diff extraction accept `bun_repl` |
| `crates/pa-tui/src/custom_message/injected_prompt.rs` | The injected-prompt headers (`Restored <Bun|Python> kernel state`, `<JavaScript|Python> skills unavailable`) follow the runtime |
| `crates/pa-core/src/refinement/ranking.rs` | The harness digest's call contract follows the runtime |
| `crates/pa-core/src/goals.rs` | The goal continuation prompt names the running REPL |
| `README.md`, `docs/google-workspace-mcp.md` | Product docs describe the shipped kernel |
| `crates/pa-tui/src/code_preview/{python,mod}.rs` | A cell the Python scanner cannot parse previews its own lines (Bun cells) |
| `crates/pa-cli/src/command_registry.rs` | The `--help` about-line follows the runtime |
| `crates/pa-core/src/prompts/layers/usage.md`, `opinionated.md`, `model_prompts.toml` | Kernel-flavoured guidance |
| `crates/pa-core/src/skills/**` | Skill classification (`python_import` metadata) |
| `skills/**` | Built-in skill packages |
| `crates/pa-core/src/settings/types.rs`, `load.rs` | `pythonCellTimeoutMs` + the `javascriptCellTimeoutMs` alias |

### Build, packaging, verification

| Path | Why the fork owns it |
| --- | --- |
| `test/**` | The fork's verification suite (cases + harness) |
| `scripts/fork/**` | Upstream classification and drift tooling |
| `docs/fork/**` | Ownership map and sync ledger |
| `.gitignore` | Keeps the fork's local tool state (agent/session dirs) out of history |
| `update-prompt.md` | The upstream-sync runbook handed to an agent |
| `.github/workflows/ci.yml` | Runtime-suite lane, kernel drift check |
| `.github/workflows/fork-release.yml` | The fork's native packaging/release lane |
| `Makefile` | Runtime sidecar wiring |
| `packaging/**`, `install-rust.sh`, `install.ps1` | Sidecar layout beside the binary |
| `scripts/package_release.py`, `scripts/release/**` | The Bun sidecar rides the release payload (including their synthetic-tree fixtures) |
| `scripts/check_kernel_env.py`, `scripts/check_ipython_diff_frames.py`, `scripts/check_restore_notice.py` | Assert Python kernel semantics |

## Retained upstream assets (deliberately not deleted)

`prime-agent-runtime/` and `crates/pa-core/src/kernel/bootstrap/venv/**` stay in
the tree even though the product always runs Bun:

- upstream keeps fixing the Python kernel; keeping the files means those fixes
  merge cleanly (dormant) instead of conflicting;
- the Python path stays available to library callers and upstream tests (the
  shipped binary no longer selects it);
- the `pa-daemon` end-to-end tests (69 files reference `PRIME_AGENT_KERNEL_PYTHON`
  / `kernel-venv` / `prime-agent-runtime`) keep running unchanged.

Deleting them is a separate, deliberate decision (fork phase 6).

## Upstream-owned

Everything else, including all of `pa-ai`, `pa-tui`, `pa-models`, `pa-telemetry`,
and the large majority of `pa-daemon` and `pa-cli`.

## Checking ownership

The fork's diff against upstream should touch nothing outside the tables above:

```bash
git diff --name-only upstream/main...HEAD
python3 scripts/fork/classify_upstream.py --range upstream/main...HEAD
```
