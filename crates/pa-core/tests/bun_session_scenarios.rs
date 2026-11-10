//! Multi-scenario verification of the Bun kernel through the real manager.
//!
//! `bun_kernel_e2e` and `bun_provisioner_e2e` pin startup and the skill
//! pipeline. This suite walks the scenarios a live session actually hits:
//!
//! 1. a cell that blocks past its time limit is interrupted and reported;
//! 2. a detached `bash()` that outlives its cell fires the `[bash.done]` lane,
//!    and the kernel keeps serving;
//! 3. an explicitly named interpreter still wins over the runtime selection,
//!    which is the fork's promise that upstream's Python path is untouched.
//!
//! Skips when Bun is not installed; `PRIME_AGENT_BUN_E2E=required` turns that
//! skip into a failure.
#![cfg(unix)]
// Kernel manager futures follow the crate's existing integration-test disposition.
#![allow(clippy::large_futures, clippy::await_holding_lock)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use pa_core::kernel::manager::{KernelStartOptions, ReplKernelManager};
use pa_core::kernel::shared::{
    host_handler, ExecuteOptions, ExecuteStatus, HostRequestHandlers, KernelManagerOptions,
    KernelShutdownOptions, BASH_COMPLETED_REQUEST_TYPE,
};

fn runtime_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../prime-agent-bun-runtime")
}

fn on_path(program: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(program))
        .find(|candidate| candidate.is_file())
}

fn bun_available() -> bool {
    if on_path("bun").is_some() && runtime_dir().join("src/repl.ts").is_file() {
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

/// Serializes the tests in this binary: the runtime selection is process-global.
fn env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn manager(cwd: &std::path::Path, handlers: HostRequestHandlers) -> ReplKernelManager {
    ReplKernelManager::new(KernelManagerOptions {
        python: None,
        cwd: Some(cwd.to_path_buf()),
        env: HashMap::new(),
        session_id: Some("bun-scenarios".to_string()),
        host_handlers: handlers,
        python_skills: Vec::new(),
        snapshot: None,
        bootstrap_code: None,
        stderr_log_path: None,
        on_background_work_settled: None,
    })
}

#[tokio::test]
async fn a_blocking_cell_is_interrupted_at_its_time_limit() {
    if !bun_available() {
        return;
    }
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    std::env::set_var("PRIME_AGENT_KERNEL_RUNTIME", "bun");
    std::env::set_var("PRIME_AGENT_BUN_RUNTIME_DIR", runtime_dir());

    let dir = tempfile::TempDir::new().expect("temp dir");
    let manager = manager(dir.path(), HostRequestHandlers::new());
    tokio::time::timeout(
        Duration::from_secs(60),
        manager.start(KernelStartOptions::default()),
    )
    .await
    .expect("the Bun kernel must become ready")
    .expect("the Bun kernel must start");

    // A cell that never settles on its own: the host arms the limit and the
    // kernel must report the interruption rather than wedging the session.
    let timed_out = tokio::time::timeout(
        Duration::from_secs(60),
        manager.execute(
            "await new Promise(() => {});",
            ExecuteOptions {
                cell_timeout_ms: Some(700),
                ..ExecuteOptions::default()
            },
        ),
    )
    .await
    .expect("a limited cell must settle")
    .expect("a limited cell must return a result");
    assert_eq!(
        timed_out.timed_out_after_ms,
        Some(700),
        "the result names the armed limit: {timed_out:?}"
    );
    assert_eq!(
        timed_out.status,
        ExecuteStatus::Error,
        "the limit is a failure"
    );

    // The kernel keeps serving after the interruption.
    let after = tokio::time::timeout(
        Duration::from_secs(30),
        manager.execute("6 * 7", ExecuteOptions::default()),
    )
    .await
    .expect("the next cell must settle")
    .expect("the next cell must execute");
    assert_eq!(
        (after.status, after.result.as_deref()),
        (ExecuteStatus::Ok, Some("42")),
        "the kernel resumes after a timed-out cell"
    );

    tokio::time::timeout(
        Duration::from_secs(30),
        manager.shutdown(KernelShutdownOptions::default()),
    )
    .await
    .expect("shutdown must finish")
    .expect("shutdown must succeed");
}

#[tokio::test]
async fn a_detached_bash_completion_wakes_the_host_lane() {
    if !bun_available() {
        return;
    }
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    std::env::set_var("PRIME_AGENT_KERNEL_RUNTIME", "bun");
    std::env::set_var("PRIME_AGENT_BUN_RUNTIME_DIR", runtime_dir());

    let notices: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let mut handlers = HostRequestHandlers::new();
    {
        let notices = Arc::clone(&notices);
        handlers.register(
            BASH_COMPLETED_REQUEST_TYPE,
            host_handler(move |payload| {
                let notices = Arc::clone(&notices);
                Box::pin(async move {
                    notices.lock().expect("lock").push(payload.data.clone());
                    Ok(serde_json::json!({}))
                })
            }),
        );
    }

    let dir = tempfile::TempDir::new().expect("temp dir");
    let manager = manager(dir.path(), handlers);
    tokio::time::timeout(
        Duration::from_secs(60),
        manager.start(KernelStartOptions::default()),
    )
    .await
    .expect("the Bun kernel must become ready")
    .expect("the Bun kernel must start");

    // The cell starts the command and ends immediately; the command outlives it.
    let started = tokio::time::timeout(
        Duration::from_secs(30),
        manager.execute(
            "globalThis.later = bash('sleep 0.6; echo detached-done'); 'started'",
            ExecuteOptions::default(),
        ),
    )
    .await
    .expect("the starting cell must settle")
    .expect("the starting cell must execute");
    assert_eq!(started.status, ExecuteStatus::Ok);

    // The `[bash-done]` lane fires once the command finishes.
    let mut observed = None;
    for _ in 0..60 {
        if let Some(notice) = notices.lock().expect("lock").first().cloned() {
            observed = Some(notice);
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let notice = observed.expect("the detached command must fire the bash.completed lane");
    assert!(
        notice
            .get("pid")
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|pid| pid > 0),
        "the notice carries a positive pid: {notice}"
    );
    assert!(
        notice
            .get("command")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|command| command.contains("detached-done")),
        "the notice carries the command: {notice}"
    );
    assert_eq!(
        notice.get("exitCode").and_then(serde_json::Value::as_i64),
        Some(0),
        "the notice carries the exit code: {notice}"
    );

    tokio::time::timeout(
        Duration::from_secs(30),
        manager.shutdown(KernelShutdownOptions::default()),
    )
    .await
    .expect("shutdown must finish")
    .expect("shutdown must succeed");
}

#[tokio::test]
async fn an_explicit_interpreter_still_wins_over_the_runtime_selection() {
    if !bun_available() {
        return;
    }
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    std::env::set_var("PRIME_AGENT_KERNEL_RUNTIME", "bun");
    std::env::set_var("PRIME_AGENT_BUN_RUNTIME_DIR", runtime_dir());

    // A fake "python" that speaks protocol v3 and stamps its own identity.
    let dir = tempfile::TempDir::new().expect("temp dir");
    let fake = dir.path().join("fake-kernel");
    std::fs::write(
        &fake,
        "#!/usr/bin/env python3\n\
         import json, sys\n\
         print(json.dumps({'event': 'ready', 'protocol': 3, 'python': '3.13.0'}), flush=True)\n\
         for line in sys.stdin:\n\
         \x20   req = json.loads(line)\n\
         \x20   if req.get('type') == 'execute':\n\
         \x20       print(json.dumps({'event': 'result', 'id': req['id'], 'text': 'python-served'}), flush=True)\n\
         \x20   print(json.dumps({'event': 'done', 'id': req.get('id'), 'status': 'ok'}), flush=True)\n",
    )
    .expect("write the fake interpreter");
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }

    let manager = ReplKernelManager::new(KernelManagerOptions {
        python: Some(fake),
        cwd: Some(dir.path().to_path_buf()),
        env: HashMap::new(),
        session_id: Some("bun-scenarios-python-override".to_string()),
        host_handlers: HostRequestHandlers::new(),
        python_skills: Vec::new(),
        snapshot: None,
        bootstrap_code: None,
        stderr_log_path: None,
        on_background_work_settled: None,
    });
    tokio::time::timeout(
        Duration::from_secs(30),
        manager.start(KernelStartOptions::default()),
    )
    .await
    .expect("the named interpreter must become ready")
    .expect("the named interpreter must start");

    let served = tokio::time::timeout(
        Duration::from_secs(30),
        manager.execute("anything", ExecuteOptions::default()),
    )
    .await
    .expect("the cell must settle")
    .expect("the cell must execute");
    assert_eq!(
        served.result.as_deref(),
        Some("python-served"),
        "an explicitly named interpreter wins over the Bun default"
    );

    tokio::time::timeout(
        Duration::from_secs(30),
        manager.shutdown(KernelShutdownOptions::default()),
    )
    .await
    .expect("shutdown must finish")
    .expect("shutdown must succeed");
}
