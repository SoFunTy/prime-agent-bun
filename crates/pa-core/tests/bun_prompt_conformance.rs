//! Recursive conformance: a Bun session's model-facing surface must never claim
//! to be Python.
//!
//! This is the fork's prompt gate. It assembles the real system prompt with the
//! Bun runtime selected and asserts:
//!
//! 1. the kernel tool is `bun_repl`, and the legacy aliases still dispatch;
//! 2. the prompt carries the `kernel-bun` layer and every required JS fact;
//! 3. the **dynamic tail** — the fork-owned, session-specific part — contains no
//!    Python claim at all;
//! 4. the runtime vocabulary's tool text (`dictionary()`) is Bun/JavaScript;
//! 5. the Python default keeps every upstream spelling, so parity fixtures and
//!    upstream tests are untouched.
//!
//! The tool *definition*'s wiring to that vocabulary is pinned by a unit test in
//! `crates/pa-core/src/tools/ipython.rs` (the `tools` module is crate-private).
//!
//! The static `core.md` layer is upstream text this fork deliberately supersedes
//! (the `kernel-bun` layer translates it), so it is checked for the layer's
//! presence, not for absence of Python spellings.
use pa_core::kernel::vocabulary;
use pa_core::prompts::system_prompt::{
    build_system_prompt, system_prompt_breakdown, BuildSystemPromptOptions,
};

fn prompt_options(tool_name: &'static str) -> BuildSystemPromptOptions<'static> {
    BuildSystemPromptOptions {
        cwd: "/w".to_string(),
        selected_tools: Some(vec![tool_name]),
        ..Default::default()
    }
}

/// The fork-owned, session-specific part of the prompt.
fn dynamic_tail(tool_name: &'static str) -> String {
    let breakdown = system_prompt_breakdown(&prompt_options(tool_name));
    breakdown.assembled[breakdown.cached_prefix_len..].to_string()
}

const PYTHON_CLAIMS: &[&str] = &[
    "python_repl",
    "Python REPL",
    "Python kernel",
    "Python cell",
    "Python variable",
    "CPython",
    "asyncio",
    "os.chdir",
    "os.environ",
    "uv pip",
    "subprocess",
    "python_import",
];

const REQUIRED_BUN_FACTS: &[&str] = &[
    "bun_repl",
    "Kernel runtime: Bun",
    "Top-level `await` works",
    "await rlm.spawn",
    "await bash",
    "mcp.call_tool",
    "process.chdir",
    "bun add",
    "await edit({ path",
    "Bun.inspect",
];

fn assert_no_python_claim(label: &str, text: &str) {
    for claim in PYTHON_CLAIMS {
        assert!(
            !text.contains(claim),
            "{label} must not claim {claim}:\n{text}"
        );
    }
}

/// One test, because the selection is process-global: the phases must not race.
#[test]
fn the_model_facing_surface_follows_the_kernel_runtime() {
    std::env::set_var("PRIME_AGENT_KERNEL_RUNTIME", "bun");

    assert_eq!(pa_types::ai::kernel_tool_name(), "bun_repl");
    for alias in [
        "bun_repl",
        "python_repl",
        "bun",
        "python",
        "ipython",
        "javascript",
    ] {
        assert!(
            pa_types::ai::is_kernel_tool_name(alias),
            "{alias} must still dispatch to the kernel tool"
        );
    }

    // The runtime vocabulary the tool definition and the notices read.
    let words = vocabulary::dictionary();
    assert_eq!(words.runtime, "Bun");
    assert_no_python_claim("the tool description", words.tool_description);
    assert_no_python_claim("the tool prompt snippet", words.tool_prompt_snippet);
    assert_no_python_claim("the tool code help", words.tool_code_help);
    assert!(words.tool_prompt_snippet.starts_with("bun_repl"));
    assert!(words.tool_description.contains("Bun REPL"));

    // The assembled prompt.
    let prompt = build_system_prompt(&prompt_options("bun_repl"));
    for fact in REQUIRED_BUN_FACTS {
        assert!(prompt.contains(fact), "the Bun prompt must state {fact}");
    }
    let breakdown = system_prompt_breakdown(&prompt_options("bun_repl"));
    assert!(
        breakdown
            .segments
            .iter()
            .any(|segment| segment.name == "kernel-bun"),
        "the kernel-bun layer must join the static prefix"
    );

    // The dynamic tail is entirely fork-owned: no Python claim may survive.
    assert_no_python_claim("the Bun prompt's dynamic tail", &dynamic_tail("bun_repl"));

    // The Python default keeps every upstream spelling.
    std::env::remove_var("PRIME_AGENT_KERNEL_RUNTIME");
    std::env::remove_var("PRIME_AGENT_KERNEL_BUN");

    assert_eq!(pa_types::ai::kernel_tool_name(), "python_repl");
    let python = build_system_prompt(&prompt_options("python_repl"));
    assert!(
        python.contains("python_repl"),
        "the Python default keeps the upstream name"
    );
    assert!(
        !python.contains("Kernel runtime: Bun"),
        "the kernel-bun layer must not appear without the Bun runtime"
    );
    let python_words = vocabulary::dictionary();
    assert_eq!(python_words.runtime, "Python");
    assert!(python_words.tool_prompt_snippet.starts_with("python_repl"));
}
