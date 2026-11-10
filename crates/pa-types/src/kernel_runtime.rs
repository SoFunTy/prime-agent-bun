//! Which kernel runtime this process runs.
//!
//! The selection lives in this crate because it is shared vocabulary: the session
//! engine (`pa-core`) owns the kernel, but the terminal UI (`pa-tui`) depends on
//! `pa-types` alone and still has to label agent cells with the right language.
//!
//! Layering, from least to most authoritative:
//!
//! - **library default**: nothing configured means the upstream Python runtime;
//! - **explicit (library)**: `PRIME_AGENT_KERNEL_RUNTIME=bun` (or an explicit
//!   `PRIME_AGENT_KERNEL_BUN`) selects the Bun runtime, and an interpreter passed
//!   straight to the kernel manager wins over everything;
//! - **product**: `prime-agent` overwrites `PRIME_AGENT_KERNEL_RUNTIME=bun` at
//!   startup, so the shipped binary is Bun-only and has no Python fallback.

/// Selects the kernel runtime: `bun` or `python`.
pub const KERNEL_RUNTIME_ENV: &str = "PRIME_AGENT_KERNEL_RUNTIME";

/// Explicit Bun binary path (implies the Bun runtime).
pub const BUN_BIN_ENV: &str = "PRIME_AGENT_KERNEL_BUN";

/// Whether the Bun kernel runtime is the selected one.
///
/// Reads the same rule `pa-core` uses to pick the launcher, so the UI and the
/// engine can never disagree.
#[must_use]
pub fn selected() -> bool {
    selected_from(
        std::env::var(KERNEL_RUNTIME_ENV).ok().as_deref(),
        std::env::var(BUN_BIN_ENV).ok().as_deref(),
    )
}

/// The selection rule, without touching the process environment.
#[must_use]
pub fn selected_from(runtime: Option<&str>, bun_bin: Option<&str>) -> bool {
    match runtime {
        Some(value) => value.eq_ignore_ascii_case("bun"),
        None => bun_bin.is_some_and(|value| !value.is_empty()),
    }
}

/// The language agent cells are written in (`"javascript"` or `"python"`).
#[must_use]
pub fn language() -> &'static str {
    language_from(selected())
}

/// The kernel's display name for a cell label (`Python` / `Bun`).
#[must_use]
pub fn cell_label() -> &'static str {
    cell_label_from(selected())
}

/// The cell label for one selection. Pure so the label is testable.
#[must_use]
pub fn cell_label_from(bun_kernel: bool) -> &'static str {
    if bun_kernel {
        "Bun"
    } else {
        "Python"
    }
}

/// The language for one selection. Pure so the label is testable.
#[must_use]
pub fn language_from(bun_kernel: bool) -> &'static str {
    if bun_kernel {
        "javascript"
    } else {
        "python"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cell_language_follows_the_selection() {
        assert_eq!(language_from(false), "python");
        assert_eq!(language_from(true), "javascript");
    }

    #[test]
    fn a_cell_label_says_which_kernel_ran_it() {
        assert_eq!(cell_label_from(false), "Python");
        assert_eq!(cell_label_from(true), "Bun");
    }

    #[test]
    fn the_selection_rule_is_opt_in() {
        assert!(!selected_from(None, None), "unset keeps the Python kernel");
        assert!(!selected_from(Some(""), None));
        assert!(selected_from(Some("bun"), None));
        assert!(selected_from(Some("Bun"), None), "case-insensitive");
        assert!(!selected_from(Some("python"), Some("/usr/bin/bun")));
        assert!(selected_from(None, Some("/usr/bin/bun")));
        assert!(!selected_from(None, Some("")));
    }
}
