//! End-to-end verification of the Bun kernel through the **session path**.
//!
//! `bun_kernel_e2e.rs` drives `ReplKernelManager` directly. This test drives
//! `IpythonKernelProvisioner` — the seam the daemon's session engine uses — so it
//! covers the whole product chain: runtime selection, Bun resolution, the
//! protocol handshake, the bootstrap cell, JavaScript skill preparation, and a
//! cell's real side effect.
//!
//! Skips when Bun is not installed; `PRIME_AGENT_BUN_E2E=required` turns that
//! skip into a failure.
#![cfg(unix)]
// Kernel manager futures follow the crate's existing integration-test disposition.
#![allow(clippy::large_futures)]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pa_core::kernel::bootstrap::{KernelPythonSkill, UnavailablePythonSkills};
use pa_core::kernel::provisioner::{
    IpythonKernelProvisioner, IpythonKernelProvisionerOptions, UnavailableSkillsCallback,
};
use pa_core::kernel::shared::{ExecuteOptions, ExecuteStatus, HostRequestHandlers};

fn runtime_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../prime-agent-bun-runtime")
}

fn skills_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../skills")
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

fn edit_skill() -> KernelPythonSkill {
    let package_path = skills_dir().join("edit");
    KernelPythonSkill {
        name: "edit".to_string(),
        import_name: "edit".to_string(),
        pyproject_path: package_path.join("pyproject.toml"),
        package_path,
    }
}

#[tokio::test]
async fn the_session_provisioner_runs_the_bun_kernel() {
    if !bun_available() {
        return;
    }
    std::env::set_var("PRIME_AGENT_KERNEL_RUNTIME", "bun");
    std::env::set_var("PRIME_AGENT_BUN_RUNTIME_DIR", runtime_dir());

    let dir = tempfile::TempDir::new().expect("temp dir");
    let reported: Arc<Mutex<Vec<UnavailablePythonSkills>>> = Arc::new(Mutex::new(Vec::new()));
    let on_unavailable_skills = {
        let reported = Arc::clone(&reported);
        Arc::new(move |errors: &UnavailablePythonSkills| {
            reported.lock().expect("lock").push(errors.clone());
        }) as UnavailableSkillsCallback
    };
    let provisioner = IpythonKernelProvisioner::new(
        dir.path(),
        IpythonKernelProvisionerOptions {
            // No interpreter: the runtime selection decides, exactly as in a
            // real session.
            python: None,
            python_skills: vec![edit_skill()],
            host_handlers: HostRequestHandlers::new(),
            on_unavailable_skills: Some(on_unavailable_skills),
            ..Default::default()
        },
    );

    // `ensure` covers lazy creation, startup, the ready handshake, and the
    // bootstrap cell that prepares the executable skills.
    let manager = tokio::time::timeout(Duration::from_secs(120), provisioner.ensure(None, None))
        .await
        .expect("the Bun kernel must become ready")
        .expect("the Bun kernel must start");

    // The runtime identity, read by the kernel itself.
    let identity = tokio::time::timeout(
        Duration::from_secs(30),
        manager.execute("Bun.version", ExecuteOptions::default()),
    )
    .await
    .expect("a cell must settle")
    .expect("a cell must execute");
    assert_eq!(
        identity.status,
        ExecuteStatus::Ok,
        "a Bun-only global must read back: {:?}",
        identity.stdout
    );
    assert!(
        identity
            .result
            .as_deref()
            .is_some_and(|text| text.starts_with('"') && text.len() > 3),
        "the kernel must report its Bun version, got {:?}",
        identity.result
    );

    // The bootstrap prepared the JavaScript skill during `ensure`.
    let skill = tokio::time::timeout(
        Duration::from_secs(30),
        manager.execute("typeof edit", ExecuteOptions::default()),
    )
    .await
    .expect("a cell must settle")
    .expect("a cell must execute");
    assert_eq!(
        (skill.status, skill.result.as_deref()),
        (ExecuteStatus::Ok, Some("\"function\"")),
        "the bootstrap must bind the ported JavaScript skill"
    );

    // And it does its real work.
    let target = dir.path().join("provisioner-target.txt");
    std::fs::write(&target, "before\n").expect("seed the edit target");
    let edited = tokio::time::timeout(
        Duration::from_secs(30),
        manager.execute(
            &format!(
                "await edit({{ path: {}, old_str: 'before', new_str: 'after' }})",
                serde_json::to_string(&target.to_string_lossy().to_string()).expect("encode path")
            ),
            ExecuteOptions::default(),
        ),
    )
    .await
    .expect("a cell must settle")
    .expect("a cell must execute");
    assert_eq!(edited.status, ExecuteStatus::Ok, "{:?}", edited.stdout);
    assert_eq!(
        std::fs::read_to_string(&target).expect("read the edited file"),
        "after\n",
        "the session-path skill edit must reach the disk"
    );

    assert!(
        reported.lock().expect("lock").is_empty(),
        "the Bun bootstrap must not report unavailable skills"
    );
    provisioner.dispose(None).await;
}
