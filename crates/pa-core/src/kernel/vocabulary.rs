//! Kernel vocabulary: the words model-facing notices use for the running kernel.
//!
//! The fork can run two kernels (upstream's Python runtime and the Bun runtime),
//! so a notice that says "your Python kernel" would be false in a Bun session.
//! Every user/model-visible string that names the kernel or its language comes
//! from here.
//!
//! Two rules keep this safe:
//!
//! - the **Python branch holds the upstream sentences byte for byte**, because
//!   the TS-parity golden corpus and the notice tests pin them;
//! - the **bracketed notice tags** (`[python-state]`, `[python-state-restored]`,
//!   `[python-skills-unavailable]`) and `<ipython_kernel_reset>` are *preserved
//!   identifiers*: the TUI classifies injected prompts by their prefix, and the
//!   daemon's traces assert them, so they never follow the runtime.

/// The complete, runtime-accurate sentences one kernel selection uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KernelVocabulary {
    /// Human name of the runtime, e.g. `Python` or `Bun`.
    pub runtime: &'static str,
    /// The language cells are written in, e.g. `Python` or `JavaScript`.
    pub language: &'static str,
    /// `Python kernel` / `Bun kernel`.
    pub kernel: &'static str,
    /// The busy-kernel prompt's first line.
    pub busy_prompt_head: &'static str,
    /// The busy-kernel prompt's "killing restarts" line.
    pub busy_prompt_kill: &'static str,
    /// What a restart loses (the reset banner's middle sentence).
    pub restart_loss: &'static str,
    /// How to keep long work off the cell's critical path (timeout hint).
    pub timeout_hint: &'static str,
    /// The timeout message's closing clause.
    pub timeout_tail: &'static str,
    /// The working note while waiting for a busy kernel.
    pub working_wait: &'static str,
    /// The working note while restarting a busy kernel.
    pub working_restart: &'static str,
    /// How to re-apply a working directory / environment change after a restart.
    pub cwd_env_hint: &'static str,
    /// The post-compaction "your kernel persisted" sentence.
    pub compaction_persisted: &'static str,
    /// The compaction summary's persistence note, in full.
    pub summarize_persist_note: &'static str,
    /// The post-restore notice for a fresh (unrevived) kernel, in full.
    pub restore_fresh: &'static str,
    /// The post-restore notice for a revived kernel, up to the name list.
    pub restore_revived_lead: &'static str,
    /// The unavailable-skills notice's lead sentence, in full.
    pub skills_unavailable_lead: &'static str,
    /// The unavailable-skills notice's fix hint, in full.
    pub skills_fix_hint: &'static str,
    /// The message for a new cell that cannot start behind an interrupted one.
    pub busy_after_interrupt: &'static str,
    /// "Restart the <runtime> kernel to load the current skills" fragment.
    pub restart_for_skills: &'static str,
    /// The `python_repl` tool's description, in full.
    pub tool_description: &'static str,
    /// The tool's one-line prompt snippet (the tool list entry).
    pub tool_prompt_snippet: &'static str,
    /// The skills inventory's sentence about prepared kernel skills.
    pub skills_kernel_sentence: &'static str,
    /// The "do not block a cell" rule injected for the kernel session.
    pub no_long_blocking: &'static str,
    /// The line injected when the session has no kernel REPL at all.
    pub no_kernel_tool: &'static str,
    /// The `code` parameter's schema description.
    pub tool_code_help: &'static str,
    /// The REPL's name, e.g. `Python REPL` or `Bun REPL`.
    pub repl_name: &'static str,
    /// The harness digest's "call contract" paragraph.
    pub harness_call_contract: &'static str,
    /// How generic MCP connections are reached from the kernel.
    pub generic_mcp_lead: &'static str,
}

/// The vocabulary for the kernel this process selected.
#[must_use]
pub fn dictionary() -> KernelVocabulary {
    dictionary_for(crate::kernel::bun_runtime::selected())
}

/// The vocabulary for one selection. Pure so both branches stay testable.
#[must_use]
pub fn dictionary_for(bun_kernel: bool) -> KernelVocabulary {
    if bun_kernel {
        KernelVocabulary {
            runtime: "Bun",
            language: "JavaScript",
            kernel: "Bun kernel",
            busy_prompt_head: "Interrupted Bun cell is still running",
            busy_prompt_kill: "Waiting preserves the current kernel state. Killing restarts the kernel and loses in-memory bindings, imports, and running tasks.",
            restart_loss: "Bindings, imports, pending promises, and open resources from before the restart are no longer available; recreate them before using them.",
            timeout_hint: "Make it non-blocking: start the work as a promise (`const task = (async () => { ... })()`), keep the handle, and check it in later cells.",
            timeout_tail: "but long work belongs off the cell's critical path.",
            working_wait: "Waiting for Bun kernel...",
            working_restart: "Restarting Bun kernel...",
            cwd_env_hint: "re-apply any `process.chdir(...)` or `process.env` changes you still need.",
            compaction_persisted: "Your Bun kernel persisted through compaction; its remaining bindings, imports, and helpers are still available.",
            summarize_persist_note: "Note: the Bun kernel keeps running after this summary — every JavaScript binding, import, and helper you defined stays available. The cells that defined them won't appear above, so record in the summary any names worth remembering so you reuse them instead of redefining them.",
            restore_fresh: "Your previous Bun kernel state could not be revived; the kernel is starting fresh, so re-create any bindings, imports, or loaded data you need.",
            restore_revived_lead: "Your Bun kernel state was revived from your previous session.",
            skills_unavailable_lead: "These installed JavaScript skill modules failed to load into the Bun kernel, so calling them raises an error:",
            skills_fix_hint: "Their shell command forms fail the same way. Fix the load error first (for example install the missing dependency with `bun add`, or reinstall the skill), or use another approach.",
            busy_after_interrupt: "The Bun kernel is still running the previously interrupted cell. Wait and try again, or kill the kernel to start fresh.",
            restart_for_skills: "Restart the Bun kernel to load the current skills",
            tool_description: "Execute JavaScript/TypeScript code in a persistent Bun REPL (`bun_repl`). Top-level `await` is supported. Top-level declarations and loaded data persist across calls, and are revived on a best-effort basis when a session is resumed (values that cannot be serialized are dropped and reported). Run shell commands with `bash('cmd')` / `await bash('cmd')`. Project imports, tests, scripts, CLIs, and dependency checks should run through the target project's own environment.",
            tool_prompt_snippet: "bun_repl - persistent Bun (JavaScript) REPL for code, state, and bash() orchestration",
            skills_kernel_sentence: "Skills listed with an import name are prepared in this session's persistent Bun kernel and can be called directly by that global name (JavaScript).",
            no_long_blocking: "Do not run long blocking work in a cell; start long JavaScript work as a promise and check on it in later cells.",
            no_kernel_tool: "This session has no kernel REPL (`bun_repl` tool): the programmatic tools described above are unavailable here.",
            tool_code_help: "JavaScript/TypeScript code to execute in the persistent Bun REPL. Use the target project's own environment for project imports, tests, scripts, CLIs, and dependency checks instead of direct kernel imports.",
            repl_name: "Bun REPL",
            harness_call_contract: "Call contract: installed skills are JavaScript modules bound as globals in the Bun kernel; read each SKILL.md and call it with a single options object (for example `await edit({ path, old_str, new_str })`). Continual harness skill entries written for the Python kernel do not execute here; use the installed JavaScript modules and the `mcp` object instead. Spawn a continual harness subagent spec by composing a concise task prompt and calling `handle = await rlm.spawn('sub-task', name='worker')`; admission returns immediately with `rlm_child_id`, `name`, `session_dir`, and `model`, never the child's answer. Results arrive only through explicit `agent_message` replies or files; children reply with `await agent_message.send(message, receiver_role='parent')`. Use `await rlm.list_subagents()` to recover direct child handles and `await agent_message.send(..., receiver_role='child', receiver_name=handle.name)` for follow-ups. Do not invent wrappers such as `call_skill(...)`, `run_subagent(...)`, or named subagent registries.",
            generic_mcp_lead: "Generic MCP connections are accessed through the pre-imported `mcp` object in the Bun REPL, not as top-level native tool namespaces or installed skills.",
        }
    } else {
        KernelVocabulary {
            runtime: "Python",
            language: "Python",
            kernel: "Python kernel",
            busy_prompt_head: "Interrupted Python cell is still running",
            busy_prompt_kill: "Waiting preserves the current kernel state. Killing restarts the kernel and loses in-memory variables, imports, and running tasks.",
            restart_loss: "Variables, imports, async tasks, and open resources from before the restart are no longer available; recreate them before using them.",
            timeout_hint: "Make it non-blocking: start the work as a task (`task = asyncio.create_task(...)`; wrap blocking libraries with `asyncio.to_thread`) and check `task.done()` / `task.result()` in later cells.",
            timeout_tail: "but long work belongs in tasks.",
            working_wait: "Waiting for Python kernel...",
            working_restart: "Restarting Python kernel...",
            cwd_env_hint: "re-apply any `os.chdir(...)` or `os.environ[...]` changes you still need.",
            compaction_persisted: "Your Python kernel persisted through compaction; its remaining variables, imports, and helpers are still available.",
            summarize_persist_note: "Note: the Python kernel keeps running after this summary — every Python variable, import, and helper you defined stays available. The cells that defined them won't appear above, so record in the summary any names worth remembering so you reuse them instead of redefining them.",
            restore_fresh: "Your previous Python kernel state could not be revived; the kernel is starting fresh, so re-create any variables, imports, or loaded data you need.",
            restore_revived_lead: "Your Python kernel state was revived from your previous session.",
            skills_unavailable_lead: "These installed Python skill modules failed to import into the Python kernel, so calling them raises an error:",
            skills_fix_hint: "Their shell command forms fail the same way. Fix the import error first (for example install the missing dependency with `uv pip install <pkg>` or reinstall the skill into the kernel venv), or use another approach.",
            busy_after_interrupt: "The Python kernel is still running the previously interrupted cell. Wait and try again, or kill the kernel to start fresh.",
            restart_for_skills: "Restart the Python kernel to load the current skills",
            tool_description: "Execute Python code in a persistent Python REPL. Top-level `await` is supported. Variables, imports, and loaded data persist across calls, and are revived on a best-effort basis when a session is resumed (objects that cannot be serialized are dropped and reported). Run shell commands with `bash('cmd')` / `await bash('cmd')`. Project imports, tests, scripts, CLIs, and dependency checks should run through the target project's own environment.",
            tool_prompt_snippet: "python_repl - persistent Python REPL for code, state, and bash() orchestration",
            skills_kernel_sentence: "Skills with a python_import are prepared in the persistent Python kernel when available and can be called directly by that import name.",
            no_long_blocking: "Do not run long blocking work in a cell; start long Python work as an asyncio task and check on it in later cells.",
            no_kernel_tool: "This session has no Python REPL (`python_repl` tool): the programmatic tools described above are unavailable here.",
            tool_code_help: "Python code to execute in the persistent Python REPL. Use the target project's own environment for project imports, tests, scripts, CLIs, and dependency checks instead of direct kernel imports.",
            repl_name: "Python REPL",
            harness_call_contract: "Call contract: read each installed Python skill's SKILL.md and call its documented module function in the Python REPL; do not assume a `.run` entrypoint. Use `<skill_import> ...` in shell when a CLI exists. Continual harness skill entries are Python REPL skills with an explicit Python `reference` and `arguments` contract. Spawn a continual harness subagent spec by composing a concise task prompt and calling `handle = await rlm.spawn('sub-task', name='worker')`; admission returns immediately with `rlm_child_id`, `name`, `session_dir`, and `model`, never the child's answer. Results arrive only through explicit `agent_message` replies or files; children reply with `await agent_message.send(message, receiver_role='parent')`. Use `await rlm.list_subagents()` to recover direct child handles and `await agent_message.send(..., receiver_role='child', receiver_name=handle.name)` for follow-ups. Do not invent wrappers such as `call_skill(...)`, `run_subagent(...)`, or named subagent registries.",
            generic_mcp_lead: "Generic MCP connections are accessed through the pre-imported Python `mcp` object in the Python REPL, not as top-level native tool namespaces or installed Python skills.",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_runtimes_have_a_complete_vocabulary() {
        for (bun, runtime, language, kernel) in [
            (false, "Python", "Python", "Python kernel"),
            (true, "Bun", "JavaScript", "Bun kernel"),
        ] {
            let words = dictionary_for(bun);
            assert_eq!(
                (words.runtime, words.language, words.kernel),
                (runtime, language, kernel)
            );
            for field in [
                words.busy_prompt_head,
                words.busy_prompt_kill,
                words.restart_loss,
                words.timeout_hint,
                words.timeout_tail,
                words.working_wait,
                words.working_restart,
                words.cwd_env_hint,
                words.compaction_persisted,
                words.summarize_persist_note,
                words.restore_fresh,
                words.restore_revived_lead,
                words.skills_unavailable_lead,
                words.skills_fix_hint,
                words.busy_after_interrupt,
                words.restart_for_skills,
                words.tool_description,
                words.tool_prompt_snippet,
                words.skills_kernel_sentence,
                words.no_long_blocking,
                words.no_kernel_tool,
                words.tool_code_help,
                words.repl_name,
                words.harness_call_contract,
                words.generic_mcp_lead,
            ] {
                assert!(!field.trim().is_empty(), "{runtime} vocabulary is complete");
            }
            assert!(
                words.busy_after_interrupt.contains(kernel),
                "the busy message names the running kernel"
            );
        }
    }

    #[test]
    fn neither_runtime_teaches_the_other_language() {
        let bun = dictionary_for(true);
        let python = dictionary_for(false);
        for text in [
            bun.busy_prompt_kill,
            bun.restart_loss,
            bun.timeout_hint,
            bun.cwd_env_hint,
            bun.summarize_persist_note,
            bun.skills_fix_hint,
        ] {
            assert!(
                !text.contains("asyncio"),
                "Bun text must not teach asyncio: {text}"
            );
            assert!(
                !text.contains("os.chdir"),
                "Bun text must not teach os.chdir: {text}"
            );
            assert!(
                !text.contains("uv pip"),
                "Bun text must not teach uv pip: {text}"
            );
        }
        for text in [
            python.timeout_hint,
            python.cwd_env_hint,
            python.skills_fix_hint,
        ] {
            assert!(
                !text.contains("process.chdir"),
                "Python text must not teach process.chdir: {text}"
            );
        }
    }
}
