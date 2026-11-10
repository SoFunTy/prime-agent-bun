//! The Bun kernel runtime seam.
//!
//! The upstream kernel is a Python process (`python -m rlm.repl`) speaking REPL
//! protocol v3. This fork ships an alternative runtime — a Bun process running
//! `prime-agent-bun-runtime/src/repl.ts` — that speaks the same protocol, so the
//! whole `crates/pa-core/src/kernel/manager` layer, the protocol types, the
//! snapshot lifecycle, and every host-request handler are shared unchanged.
//!
//! Selection has two layers:
//!
//! - **product**: [`apply_product_default`] runs once at the composition root and
//!   selects the Bun runtime unconditionally — `prime-agent` is a Bun-kernel
//!   product with no Python fallback;
//! - **library**: explicit opt-in. `PRIME_AGENT_KERNEL_RUNTIME=bun` (or an
//!   explicit `PRIME_AGENT_KERNEL_BUN`) selects the Bun runtime; nothing set
//!   keeps upstream's Python default, so upstream's tests and library callers
//!   are never surprised.
//!
//! An explicit interpreter passed to the manager (`KernelManagerOptions::python`)
//! always wins over both.
//!
//! Resolution and version validation live here; `startup.rs` consumes the
//! resulting [`KernelLauncher`]. Nothing in this module starts a process except
//! the one-shot `bun --version` probe in [`launcher`].

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context};

use crate::kernel::shared::KernelLauncher;

/// Selects the kernel runtime (`bun` or `python`). The names and the rule live
/// in `pa-types::kernel_runtime` so the UI and the engine cannot disagree.
pub use pa_types::kernel_runtime::{BUN_BIN_ENV, KERNEL_RUNTIME_ENV};
/// Explicit directory holding the Bun runtime (`src/repl.ts`).
pub const BUN_RUNTIME_DIR_ENV: &str = "PRIME_AGENT_BUN_RUNTIME_DIR";
/// Directory name of the runtime payload, beside the binary or at the checkout root.
pub const RUNTIME_DIR_NAME: &str = "prime-agent-bun-runtime";
/// Entry file inside the runtime directory.
pub const RUNTIME_ENTRY: &str = "src/repl.ts";

/// Lowest Bun release the runtime supports (`Bun.serialize`/`Bun.Image` era).
pub const MIN_BUN_VERSION: (u64, u64, u64) = (1, 3, 14);

/// Whether the Bun kernel runtime is the selected one.
#[must_use]
pub fn selected() -> bool {
    pa_types::kernel_runtime::selected()
}

/// The library selection rule, without touching the process environment.
#[must_use]
pub fn selected_from(runtime: Option<&str>, bun_bin: Option<&str>) -> bool {
    pa_types::kernel_runtime::selected_from(runtime, bun_bin)
}

/// Apply the fork's product runtime: `prime-agent` always runs the Bun kernel.
///
/// Called once from the composition root (`prime-agent`), never from library
/// code, so `pa-core`'s own default stays upstream's Python runtime and the
/// upstream test surface keeps working unchanged. The assignment overwrites
/// `PRIME_AGENT_KERNEL_RUNTIME`, so the product has no Python fallback: an
/// install without Bun fails the kernel start with the actionable error from
/// [`launcher`]. An interpreter passed straight to the manager still wins.
pub fn apply_product_default() {
    std::env::set_var(KERNEL_RUNTIME_ENV, "bun");
}

/// Parse a `bun --version` line (`1.4.1`, `1.4.1-canary.1+abc`).
#[must_use]
pub fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let first = text.split_whitespace().next()?;
    let mut parts = first.split(&['.', '-', '+'][..]);
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    Some((major, minor, patch))
}

/// Whether a parsed version satisfies [`MIN_BUN_VERSION`].
#[must_use]
pub fn version_supported(version: (u64, u64, u64)) -> bool {
    version >= MIN_BUN_VERSION
}

/// Resolve the Bun binary: the env override, then `PATH`, then `~/.bun/bin/bun`.
///
/// # Errors
///
/// Returns an error when no candidate exists on disk.
pub fn resolve_bun(explicit: Option<&Path>) -> anyhow::Result<PathBuf> {
    if let Some(path) = explicit {
        return path
            .is_file()
            .then(|| path.to_path_buf())
            .ok_or_else(|| anyhow!("{} does not exist: {}", BUN_BIN_ENV, path.display()));
    }
    if let Ok(from_env) = std::env::var(BUN_BIN_ENV) {
        if !from_env.is_empty() {
            let path = PathBuf::from(&from_env);
            if path.is_file() {
                return Ok(path);
            }
            return Err(anyhow!("{BUN_BIN_ENV} does not exist: {}", path.display()));
        }
    }
    if let Some(found) = which("bun") {
        return Ok(found);
    }
    if let Some(home) = std::env::var_os("HOME") {
        let candidate = PathBuf::from(home).join(".bun").join("bin").join("bun");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(anyhow!(
        "the Bun kernel runtime is selected but no bun binary was found; install Bun \
         (https://bun.sh/install) or set {BUN_BIN_ENV}"
    ))
}

fn which(program: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(program))
        .find(|candidate| candidate.is_file())
}

/// One candidate runtime directory is usable when it holds the entry file.
#[must_use]
pub fn is_runtime_dir(dir: &Path) -> bool {
    dir.join(RUNTIME_ENTRY).is_file()
}

/// Resolve the runtime payload directory, mirroring the Python runtime's
/// packaged-sidecar-then-checkout candidate walk.
#[must_use]
pub fn resolve_runtime_dir(package: &Path, checkout: Option<&Path>) -> Option<PathBuf> {
    let mut candidates = vec![
        package.join(RUNTIME_DIR_NAME),
        package.join("dist").join(RUNTIME_DIR_NAME),
    ];
    if let Some(root) = checkout {
        candidates.push(root.join(RUNTIME_DIR_NAME));
    }
    candidates.into_iter().find_map(|candidate| {
        is_runtime_dir(&candidate).then(|| candidate.canonicalize().unwrap_or(candidate))
    })
}

/// The directory holding the installed runtime, from `PI_PACKAGE_DIR`, the
/// executable's directory, or the source checkout root.
///
/// # Errors
///
/// Returns an error when no candidate directory holds `src/repl.ts`.
pub fn require_runtime_dir() -> anyhow::Result<PathBuf> {
    let package = if let Ok(dir) = std::env::var("PI_PACKAGE_DIR") {
        if dir.is_empty() {
            default_package_dir()
        } else {
            PathBuf::from(dir)
        }
    } else {
        default_package_dir()
    };
    resolve_runtime_dir(&package, crate::packages::source_checkout_root()).ok_or_else(|| {
        anyhow!(
            "the Bun kernel runtime is selected but no {RUNTIME_DIR_NAME}/{RUNTIME_ENTRY} was found \
             beside the binary or at the checkout root; set {BUN_RUNTIME_DIR_ENV} or PI_PACKAGE_DIR"
        )
    })
}

fn default_package_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| crate::packages::exe_dir_of(&exe))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Build the launch descriptor for the Bun kernel, validating the resolved
/// binary and directory.
///
/// # Errors
///
/// Returns an error when the runtime directory or the Bun binary is missing,
/// or when the binary is older than [`MIN_BUN_VERSION`].
pub fn launcher() -> anyhow::Result<KernelLauncher> {
    let explicit_dir = std::env::var(BUN_RUNTIME_DIR_ENV)
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let dir = match explicit_dir {
        Some(dir) => {
            if !is_runtime_dir(&dir) {
                return Err(anyhow!(
                    "{BUN_RUNTIME_DIR_ENV} does not contain {RUNTIME_ENTRY}: {}",
                    dir.display()
                ));
            }
            dir
        }
        None => require_runtime_dir()?,
    };
    let bun = resolve_bun(None)?;
    check_bun_version(&bun)?;
    Ok(KernelLauncher {
        program: bun,
        args: vec![
            "run".to_string(),
            dir.join(RUNTIME_ENTRY).to_string_lossy().to_string(),
        ],
        label: "Bun".to_string(),
    })
}

/// Run `bun --version` once and reject an unsupported release.
///
/// # Errors
///
/// Returns an error when the probe fails or the version is too old.
pub fn check_bun_version(bun: &Path) -> anyhow::Result<(u64, u64, u64)> {
    let output = std::process::Command::new(bun)
        .arg("--version")
        .output()
        .with_context(|| format!("failed to run {} --version", bun.display()))?;
    if !output.status.success() {
        return Err(anyhow!(
            "{} --version failed; the Bun kernel runtime needs Bun {}.{}.{}+",
            bun.display(),
            MIN_BUN_VERSION.0,
            MIN_BUN_VERSION.1,
            MIN_BUN_VERSION.2
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let version = parse_version(&text)
        .ok_or_else(|| anyhow!("could not parse a Bun version from {:?}", text.trim()))?;
    if !version_supported(version) {
        return Err(anyhow!(
            "Bun {}.{}.{} is too old for the kernel runtime; install Bun {}.{}.{}+",
            version.0,
            version.1,
            version.2,
            MIN_BUN_VERSION.0,
            MIN_BUN_VERSION.1,
            MIN_BUN_VERSION.2
        ));
    }
    Ok(version)
}

/// The bootstrap cell for the Bun runtime.
///
/// The runtime installs its own `rlm` / `bash` / `mcp` globals at startup, so
/// the bootstrap only prepares executable skills: it hands the runtime the skill
/// directories and the runtime imports each one's JavaScript entry. A skill with
/// no JavaScript entry is skipped by the runtime, so one shared `skills/` tree
/// serves both kernels. A failing import is reported through the same stdout
/// marker the Python runtime uses, so the host's existing unavailable-skill
/// notice works unchanged.
#[must_use]
pub fn bootstrap_code(skills: &[crate::kernel::bootstrap::KernelPythonSkill]) -> String {
    let specs: Vec<serde_json::Value> = skills
        .iter()
        .map(|skill| {
            serde_json::json!({
                "name": skill.name,
                "dir": skill.package_path.to_string_lossy(),
            })
        })
        .collect();
    let list = serde_json::to_string(&specs).unwrap_or_else(|_| "[]".to_string());
    format!("await __prime_agent_load_skills__({list});\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_parsing_covers_release_and_canary_forms() {
        assert_eq!(parse_version("1.4.1"), Some((1, 4, 1)));
        assert_eq!(parse_version("1.4.1-canary.1+0823e5059\n"), Some((1, 4, 1)));
        assert_eq!(parse_version("1.3.14"), Some((1, 3, 14)));
        assert_eq!(parse_version("nonsense"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn version_gate_requires_the_minimum_release() {
        assert!(version_supported(MIN_BUN_VERSION));
        assert!(version_supported((1, 4, 1)));
        assert!(version_supported((2, 0, 0)));
        assert!(!version_supported((1, 3, 13)));
        assert!(!version_supported((1, 2, 99)));
        assert!(!version_supported((0, 9, 9)));
    }

    #[test]
    fn runtime_directory_requires_the_entry_file() {
        let temp = std::env::temp_dir().join(format!("pa-bun-runtime-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        let runtime = temp.join(RUNTIME_DIR_NAME);
        std::fs::create_dir_all(runtime.join("src")).expect("create runtime dir");
        assert_eq!(resolve_runtime_dir(&temp, None), None, "no entry file yet");
        std::fs::write(runtime.join(RUNTIME_ENTRY), "// entry").expect("write entry");
        let canonical = runtime.canonicalize().expect("canonicalize runtime dir");
        assert_eq!(resolve_runtime_dir(&temp, None), Some(canonical.clone()));
        // A checkout-relative candidate resolves too.
        assert_eq!(
            resolve_runtime_dir(&temp.join("elsewhere"), Some(&temp)),
            Some(canonical)
        );
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn bootstrap_hands_the_runtime_every_skill_directory() {
        use crate::kernel::bootstrap::KernelPythonSkill;
        let skills = vec![
            KernelPythonSkill {
                name: "edit".to_string(),
                import_name: "edit".to_string(),
                package_path: std::path::PathBuf::from("/skills/edit"),
                pyproject_path: std::path::PathBuf::from("/skills/edit/pyproject.toml"),
            },
            KernelPythonSkill {
                name: "agent-message".to_string(),
                import_name: "agent_message".to_string(),
                package_path: std::path::PathBuf::from("/skills/agent-message"),
                pyproject_path: std::path::PathBuf::from("/skills/agent-message/pyproject.toml"),
            },
        ];
        let code = bootstrap_code(&skills);
        assert!(
            code.starts_with("await __prime_agent_load_skills__("),
            "{code}"
        );
        assert!(code.contains(r#""name":"edit""#), "{code}");
        assert!(code.contains(r#""dir":"/skills/agent-message""#), "{code}");
        // An empty skill set is still a valid, cheap cell.
        assert!(bootstrap_code(&[]).contains("[]"));
    }

    #[test]
    fn library_selection_is_opt_in() {
        assert!(
            !selected_from(None, None),
            "unset keeps upstream's Python default"
        );
        assert!(!selected_from(Some("python"), Some("/usr/bin/bun")));
        assert!(selected_from(Some("bun"), None));
        assert!(selected_from(Some("Bun"), None), "case-insensitive");
        assert!(selected_from(None, Some("/usr/bin/bun")));
        assert!(
            !selected_from(None, Some("")),
            "an empty binary path is not an opt-in"
        );
    }
}
