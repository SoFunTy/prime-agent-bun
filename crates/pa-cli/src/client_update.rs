//! The composition root's `/update` runner: the installer funnel with the
//! output captured — the TUI stays mounted while the install runs, so the
//! installer's own progress never writes to the live frame, and the
//! failure tail becomes the error row's message. It follows the same
//! update channel as `prime-agent update`. Both surfaces consult the
//! same pa-core Homebrew detector before entering the installer funnel.
//!
//! Fork seam: the Bun build routes `/update` to its own installer
//! (`install-bun.sh --update` beside the binary). The shared funnel would
//! install the upstream release and replace the Bun kernel.

use std::path::PathBuf;

use pa_core::update::homebrew;
use pa_core::update::installer::{self, InstallerOutput};

#[derive(Clone, Default)]
pub struct ClientUpdate;

impl pa_tui::update_command::UpdateCommands for ClientUpdate {
    fn run_update(&self) -> pa_tui::update_command::UpdateRunFuture {
        Box::pin(async {
            if let Some(kind) = std::env::current_exe()
                .ok()
                .as_deref()
                .and_then(homebrew::managed_kind)
            {
                if let Ok(cwd) = std::env::current_dir() {
                    let agent_dir = crate::config::get_agent_dir();
                    let settings = pa_core::settings::SettingsManager::create(&cwd, &agent_dir);
                    if !crate::mode::telemetry_disabled(&settings) {
                        let client =
                            pa_core::session_engine::telemetry::build_client(&settings, &agent_dir);
                        pa_telemetry::UpdateHomebrewRefusal {
                            kind: kind.as_str(),
                        }
                        .track(&client);
                        // The TUI already owns a runtime; draining in the
                        // background cannot delay the refusal row.
                        tokio::spawn(async move {
                            let _ = client.shutdown().await;
                        });
                    }
                }
                return Err(homebrew::upgrade_instruction(kind));
            }
            // The Bun build owns its updater: the shared funnel below would
            // resolve the upstream channel and install the official release.
            if pa_types::kernel_runtime::selected() {
                return run_fork_update().await;
            }
            let executable = std::env::current_exe().map_err(|error| error.to_string())?;
            if let Some(root) = pa_core::update::install::install_root_of(&executable) {
                // Reuse the CLI's managed activation/restart transaction.
                // Capturing the child keeps its progress off the live frame.
                let output = tokio::process::Command::new(executable)
                    .arg("update")
                    .env(
                        crate::public_command::SELF_UPDATE_INTERACTIVE_CHILD_ENV,
                        "1",
                    )
                    .stdin(std::process::Stdio::null())
                    .output()
                    .await
                    .map_err(|error| format!("could not start the update: {error}"))?;
                if !output.status.success() && output.status.code() != Some(75) {
                    return Err(format!(
                        "{}{}",
                        String::from_utf8_lossy(&output.stdout),
                        String::from_utf8_lossy(&output.stderr)
                    ));
                }
                return pa_core::update::install::read_installation(
                    &root,
                    pa_core::update::install::CURRENT_LAUNCHER,
                )
                .map(|installed| installed.version().to_string())
                .map_err(|error| error.to_string());
            }
            match installer::run_installer(
                Some(crate::installer_update::requested_installer_channel(None)),
                InstallerOutput::Capture,
            )
            .await
            {
                Ok(installed) => Ok(installed
                    .version
                    .unwrap_or_else(|| "the latest build".to_string())),
                Err(failure) => Err(failure.message),
            }
        })
    }
}

/// The fork's installer: staged beside the binary in the release payload, or
/// at `scripts/fork/install-bun.sh` in a source checkout.
fn fork_installer_script() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = std::env::var_os("PI_PACKAGE_DIR").filter(|value| !value.is_empty()) {
        candidates.push(PathBuf::from(dir).join("install-bun.sh"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("install-bun.sh"));
            // A source checkout: <root>/target/release -> <root>/scripts/fork.
            candidates.push(dir.join("../../scripts/fork/install-bun.sh"));
            candidates.push(dir.join("scripts/fork/install-bun.sh"));
        }
    }
    candidates.into_iter().find(|path| path.is_file())
}

/// Run the fork installer's `--update` and report the version it landed on.
async fn run_fork_update() -> pa_tui::update_command::UpdateOutcome {
    let Some(script) = fork_installer_script() else {
        return Err(
            "This Bun build has no install-bun.sh beside it; update it with the published \
             installer: `install-bun.sh --update`."
                .to_string(),
        );
    };
    let output = tokio::process::Command::new("sh")
        .arg(&script)
        .arg("--update")
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|error| format!("could not start {}: {error}", script.display()))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("{stdout}{stderr}"));
    }
    Ok(installed_version_from_output(&stdout).unwrap_or_else(|| "the latest build".to_string()))
}

/// The version the fork installer's output names: the installed line, or the
/// already-current line.
fn installed_version_from_output(stdout: &str) -> Option<String> {
    stdout.lines().find_map(|line| {
        let rest = line
            .strip_prefix("installed prime-agent-bun ")
            .or_else(|| line.strip_prefix("up to date: "))?;
        rest.split_whitespace().next().map(str::to_string)
    })
}

#[cfg(test)]
mod tests {
    use super::installed_version_from_output;

    #[test]
    fn the_installer_output_names_the_landed_version() {
        assert_eq!(
            installed_version_from_output("installed prime-agent-bun 0.10.3 to /tmp/x\n"),
            Some("0.10.3".to_string())
        );
        assert_eq!(
            installed_version_from_output("up to date: 0.10.3 (latest: 0.10.3)"),
            Some("0.10.3".to_string())
        );
        assert_eq!(installed_version_from_output("downloading ..."), None);
    }
}
