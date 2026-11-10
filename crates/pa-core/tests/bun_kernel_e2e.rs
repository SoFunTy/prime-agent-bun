//! End-to-end verification of the Bun kernel seam through the real manager.
//!
//! Starts a `ReplKernelManager` with `PRIME_AGENT_KERNEL_RUNTIME=bun` (the same
//! path `prime-agent` takes), executes cells, and asserts the protocol handshake,
//! result rendering, output capture, and namespace persistence survive the
//! process boundary.
//!
//! The suite skips when Bun is not installed so it can live in the default
//! `cargo test` set; a lane that does have Bun sets
//! `PRIME_AGENT_BUN_E2E=required` to turn the skip into a failure.
#![cfg(unix)]
// Kernel manager futures follow the crate's existing integration-test disposition.
#![allow(clippy::large_futures)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use pa_core::kernel::bootstrap::KernelPythonSkill;
use pa_core::kernel::manager::{KernelStartOptions, ReplKernelManager};
use pa_core::kernel::shared::{
    ExecuteOptions, ExecuteStatus, HostRequestHandlers, KernelManagerOptions, KernelShutdownOptions,
};

fn runtime_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../prime-agent-bun-runtime")
}

fn skills_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../skills")
}

/// The `edit` skill as the session would hand it to the kernel.
fn edit_skill() -> KernelPythonSkill {
    let package_path = skills_dir().join("edit");
    KernelPythonSkill {
        name: "edit".to_string(),
        import_name: "edit".to_string(),
        pyproject_path: package_path.join("pyproject.toml"),
        package_path,
    }
}

fn on_path(program: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(program))
        .find(|candidate| candidate.is_file())
}

/// Returns `false` when the lane has no Bun and skipping is allowed.
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

fn manager(cwd: &Path, skills: Vec<KernelPythonSkill>) -> ReplKernelManager {
    let bootstrap = pa_core::kernel::bun_runtime::bootstrap_code(&skills);
    ReplKernelManager::new(KernelManagerOptions {
        python: None,
        cwd: Some(cwd.to_path_buf()),
        env: HashMap::new(),
        session_id: Some("bun-kernel-e2e".to_string()),
        host_handlers: HostRequestHandlers::new(),
        python_skills: skills,
        snapshot: None,
        bootstrap_code: Some(bootstrap),
        stderr_log_path: None,
        on_background_work_settled: None,
    })
}

#[tokio::test]
async fn bun_kernel_serves_cells_through_the_real_manager() {
    if !bun_available() {
        return;
    }
    std::env::set_var("PRIME_AGENT_KERNEL_RUNTIME", "bun");
    std::env::set_var("PRIME_AGENT_BUN_RUNTIME_DIR", runtime_dir());

    // The model-facing prompt must tell the truth about the language the kernel
    // speaks, without renaming any wire-visible surface.
    let prompt = pa_core::prompts::system_prompt::build_system_prompt(
        &pa_core::prompts::system_prompt::BuildSystemPromptOptions::default(),
    );
    assert!(
        prompt.contains("Kernel runtime: Bun"),
        "the Bun runtime layer must join the static prompt prefix"
    );
    assert!(
        prompt.contains("await rlm.spawn"),
        "the layer documents the JavaScript call shapes"
    );

    let dir = tempfile::TempDir::new().expect("temp dir");
    let skills = vec![edit_skill()];
    let manager = manager(dir.path(), skills.clone());
    tokio::time::timeout(
        Duration::from_secs(60),
        manager.start(KernelStartOptions::default()),
    )
    .await
    .expect("the Bun kernel must become ready")
    .expect("the Bun kernel must start");

    // The process really is Bun, not the Python fallback: the cell reads
    // `Bun.version`, which only exists on a Bun runtime.
    let runtime = tokio::time::timeout(
        Duration::from_secs(30),
        manager.execute(
            "console.log('bun-version:' + Bun.version); typeof Bun === 'object' && typeof Bun.version === 'string'",
            ExecuteOptions::default(),
        ),
    )
    .await
    .expect("a cell must settle")
    .expect("a cell must execute");
    assert_eq!(
        (runtime.status, runtime.result.as_deref()),
        (ExecuteStatus::Ok, Some("true")),
        "the selected runtime must be Bun"
    );
    assert!(
        runtime.stdout.contains("bun-version:"),
        "the Bun kernel must report its own version, got {:?}",
        runtime.stdout
    );

    // Output capture plus result rendering.
    let first = tokio::time::timeout(
        Duration::from_secs(30),
        manager.execute(
            "const kept = 41; console.log('hello-from-cell'); kept + 1",
            ExecuteOptions::default(),
        ),
    )
    .await
    .expect("a cell must settle")
    .expect("a cell must execute");
    assert_eq!(first.status, ExecuteStatus::Ok);
    assert_eq!(first.result.as_deref(), Some("42"));
    assert!(
        first.stdout.contains("hello-from-cell"),
        "console.log must reach the cell's stdout, got {:?}",
        first.stdout
    );

    // The bootstrap cell the provisioner runs: it prepares the session's
    // executable skills in the kernel.
    let bootstrap = tokio::time::timeout(
        Duration::from_secs(30),
        manager.execute(
            &pa_core::kernel::bun_runtime::bootstrap_code(&skills),
            ExecuteOptions::default(),
        ),
    )
    .await
    .expect("the bootstrap cell must settle")
    .expect("the bootstrap cell must execute");
    assert_eq!(
        bootstrap.status,
        ExecuteStatus::Ok,
        "the skill bootstrap must succeed: {:?}",
        bootstrap.stdout
    );
    assert!(
        !bootstrap
            .stdout
            .contains("__PRIME_AGENT_PYTHON_SKILL_IMPORT_ERRORS__"),
        "no skill may fail to import: {:?}",
        bootstrap.stdout
    );

    // The ported JavaScript skill runs and produces its real side effect: the
    // file on disk changes, and the diff display rides the cell result.
    let target = dir.path().join("target.txt");
    std::fs::write(&target, "before\n").expect("seed the edit target");
    let edit = tokio::time::timeout(
        Duration::from_secs(30),
        manager.execute(
            &format!(
                "const r = await edit({{ path: {}, old_str: 'before', new_str: 'after' }}); r",
                serde_json::to_string(&target.to_string_lossy().to_string()).expect("encode path")
            ),
            ExecuteOptions::default(),
        ),
    )
    .await
    .expect("the edit cell must settle")
    .expect("the edit cell must execute");
    assert_eq!(
        edit.status,
        ExecuteStatus::Ok,
        "edit must succeed: {:?}",
        edit.stdout
    );
    assert_eq!(
        std::fs::read_to_string(&target).expect("read the edited file"),
        "after\n",
        "the skill's edit must reach the disk"
    );
    assert_eq!(
        edit.diffs.as_ref().map(|diffs| diffs.len()),
        Some(1),
        "the skill must emit the diff display"
    );

    // Namespace persistence across the process boundary of a cell.
    let second = tokio::time::timeout(
        Duration::from_secs(30),
        manager.execute("kept + 1", ExecuteOptions::default()),
    )
    .await
    .expect("a cell must settle")
    .expect("a cell must execute");
    assert_eq!(
        (second.status, second.result.as_deref()),
        (ExecuteStatus::Ok, Some("42")),
        "a binding from an earlier cell must survive"
    );

    // A failing cell keeps the kernel serving.
    let failure = tokio::time::timeout(
        Duration::from_secs(30),
        manager.execute("throw new Error('boom')", ExecuteOptions::default()),
    )
    .await
    .expect("a cell must settle")
    .expect("a failed cell still returns a result");
    assert_eq!(failure.status, ExecuteStatus::Error);
    assert_eq!(
        failure.error.as_ref().map(|error| error.ename.as_str()),
        Some("Error")
    );

    tokio::time::timeout(
        Duration::from_secs(30),
        manager.shutdown(KernelShutdownOptions::default()),
    )
    .await
    .expect("shutdown must finish")
    .expect("shutdown must succeed");
}
