//! End-to-end: the session the product actually creates presents **`bun_repl`**
//! and the Bun kernel really executes the cell a model asks for.
//!
//! This closes the last link in the chain. `bun_provisioner_e2e` proves the
//! session path runs the Bun kernel; the prompt-conformance test proves the tool
//! *definition* is named `bun_repl` under the Bun selection. This test drives a
//! scripted provider through a real session engine and asserts both facts from
//! one turn: the tool list the model sees, and the cell result produced by a tool
//! call the model makes.
//!
//! Skips when Bun is not installed; `PRIME_AGENT_BUN_E2E=required` turns that
//! skip into a failure.
#![allow(clippy::await_holding_lock)]

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use pa_core::session_engine::engine::{create_session, SessionEngineConfig};
use pa_core::session_engine::provider_adapter::{json_round_trip, real_stream_fn};
use pa_core::session_engine::{PromptOptions, PromptOutcome};

/// The faux provider registry is process-global (see the sibling suites).
fn faux_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn runtime_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../prime-agent-bun-runtime")
}

fn bun_available() -> bool {
    let on_path = std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join("bun"))
            .any(|candidate| candidate.is_file())
    });
    if on_path && runtime_dir().join("src/repl.ts").is_file() {
        return true;
    }
    let required = std::env::var("PRIME_AGENT_BUN_E2E").is_ok_and(|value| value == "required");
    assert!(
        !required,
        "PRIME_AGENT_BUN_E2E=required but Bun or {} is missing",
        runtime_dir().display()
    );
    eprintln!(
        "skipping: bun not on PATH or {} has no src/repl.ts",
        runtime_dir().display()
    );
    false
}

#[tokio::test]
async fn the_shipped_session_presents_bun_repl_and_bun_runs_the_cell() {
    if !bun_available() {
        return;
    }
    let _guard = faux_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    std::env::set_var("PRIME_AGENT_KERNEL_RUNTIME", "bun");
    std::env::set_var("PRIME_AGENT_BUN_RUNTIME_DIR", runtime_dir());

    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let cwd = dir.path().join("project");
    std::fs::create_dir_all(&cwd).expect("cwd");

    // The cell writes a marker to stdout and returns a value only JavaScript can
    // produce: `Bun.version` exists on no other runtime.
    let seen_cell = Arc::new(Mutex::new(false));
    let responses = vec![
        pa_ai::faux::FauxResponseStep::Message(pa_ai::faux::faux_assistant_message(
            vec![pa_ai::faux::faux_tool_call(
                pa_types::ai::BUN_TOOL_NAME,
                &serde_json::json!({
                    "code": "console.log('js-cell-ran'); Bun.version"
                }),
                Some("call-1"),
            )],
            pa_ai::faux::FauxAssistantMessageOptions::default(),
        )),
        {
            let seen_cell = Arc::clone(&seen_cell);
            pa_ai::faux::FauxResponseStep::Factory(Arc::new(
                move |context: &pa_types::ai::Context,
                      _options: Option<&pa_ai::types::StreamOptions>,
                      _call: u64,
                      _model: &pa_types::ai::Model| {
                    let text = serde_json::to_string(context).unwrap_or_default();
                    *seen_cell.lock().expect("lock") = text.contains("js-cell-ran");
                    Ok(pa_ai::faux::faux_assistant_text_message(
                        "the JS cell ran",
                        pa_ai::faux::FauxAssistantMessageOptions::default(),
                    ))
                },
            ))
        },
    ];
    let registration =
        pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
            models: Some(vec![pa_ai::faux::FauxModelDefinition {
                id: "faux-1".to_string(),
                name: Some("Faux".to_string()),
                reasoning: Some(false),
                input: Some(vec![pa_types::ai::ModelInput::Text]),
                cost: None,
                context_window: Some(100_000),
                max_tokens: Some(4_096),
            }]),
            ..Default::default()
        });
    registration.set_responses(responses);
    let model = registration.get_model();
    let stream_fn = real_stream_fn(None, model.clone());

    let engine = create_session(SessionEngineConfig {
        cwd,
        agent_dir,
        model: Some(json_round_trip(&model).expect("model conversion")),
        stream_fn: Some(stream_fn),
        tools: Vec::new(),
        ..Default::default()
    })
    .await
    .expect("create the session");

    // 1. The tool surface the model is handed.
    let names: Vec<String> = engine
        .session
        .agent()
        .state()
        .await
        .tools
        .iter()
        .map(|tool| tool.name().to_string())
        .collect();
    assert!(
        names.iter().any(|name| name == pa_types::ai::BUN_TOOL_NAME),
        "the session must present bun_repl, got {names:?}"
    );
    assert!(
        !names
            .iter()
            .any(|name| name == pa_types::ai::PYTHON_TOOL_NAME),
        "a Bun session must not present python_repl, got {names:?}"
    );

    // 2. The turn: the scripted `bun_repl` call executes on the Bun kernel.
    let outcome = tokio::time::timeout(
        std::time::Duration::from_secs(180),
        engine.prompt("run the cell", PromptOptions::default()),
    )
    .await
    .expect("the turn must settle")
    .expect("the turn must run");
    assert_eq!(outcome, PromptOutcome::Prompt);
    assert!(
        *seen_cell.lock().expect("lock"),
        "the Bun cell's stdout must reach the model's context"
    );
}
