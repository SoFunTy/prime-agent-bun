//! Static system-prompt layers assembled into the cache-stable prefix. Layers must never
//! contain session-specific values (the cache-safety guard test pins the boundary).

pub const CORE_LAYER: &str = include_str!("layers/core.md");
pub const USAGE_LAYER: &str = include_str!("layers/usage.md");
pub const OPINIONATED_LAYER: &str = include_str!("layers/opinionated.md");
/// The Bun kernel's language layer. It is part of the *static* prefix because
/// the selected runtime is process-global, so the cache-stable boundary holds.
pub const KERNEL_BUN_LAYER: &str = include_str!("layers/kernel-bun.md");

/// The runtime-language layer for a kernel selection, or `None` for the
/// upstream Python default. Pure so the gate is testable without touching the
/// process environment.
#[must_use]
pub fn runtime_layer(
    bun_kernel_selected: bool,
) -> Option<(&'static str, &'static str, &'static str)> {
    bun_kernel_selected.then_some((
        "kernel-bun",
        "prompts/layers/kernel-bun.md",
        KERNEL_BUN_LAYER,
    ))
}

/// Source file of one layer (breakdown provenance).
#[must_use]
pub fn layer_source(name: &str) -> Option<&'static str> {
    match name {
        "core" => Some("prompts/layers/core.md"),
        "usage" => Some("prompts/layers/usage.md"),
        "opinionated" => Some("prompts/layers/opinionated.md"),
        "kernel-bun" => Some("prompts/layers/kernel-bun.md"),
        "model-prompts" => Some("prompts/layers/model_prompts.toml"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_runtime_layer_is_gated_on_the_bun_kernel() {
        assert!(
            runtime_layer(false).is_none(),
            "the Python default adds no layer"
        );
        let (name, source, text) = runtime_layer(true).expect("the Bun selection adds its layer");
        assert_eq!(name, "kernel-bun");
        assert_eq!(source, "prompts/layers/kernel-bun.md");
        assert!(text.contains("Bun"), "the layer names the runtime");
        assert!(text.contains("JavaScript"), "the layer names the language");
    }
}
