//! Conformance for the on-demand skill documentation.
//!
//! `SKILL.md` and its `references/*.md` are model-facing: the model reads them
//! when a task matches, and a Python call form there is an instruction to write
//! a call that cannot work. A real session was observed doing exactly that —
//! `await edit(path="…", old_str=…, new_str=…)`, taken from `edit/SKILL.md` —
//! before these docs were swept.
//!
//! This gate keeps the sweep from regressing. It scans every skill markdown file
//! for the Python kernel forms the Bun kernel cannot serve.
#![allow(clippy::case_sensitive_file_extension_comparisons)]

use std::path::{Path, PathBuf};

fn skills_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../skills")
}

/// Files that intentionally document Python, each because the Python it shows is
/// not the kernel language: the Python runtime's own skill contract, and the
/// Prime Intellect platform SDKs (which this kernel drives over HTTP or through
/// `bash()`; both files carry the JavaScript path beside the SDK example).
const PYTHON_RUNTIME_DOCS: [&str; 3] = [
    "skill-creator/references/python-skills.md",
    "prime-intellect/references/inference.md",
    "prime-intellect/references/sandboxes.md",
];

/// Python-kernel spellings that no Bun-era skill document may contain.
const FORBIDDEN: [(&str, &str); 9] = [
    ("```python", "a Python code block"),
    ("Python REPL", "the Python REPL as the place to call from"),
    ("Python kernel", "the Python kernel as the runtime"),
    ("from PIL import", "a Python imaging import"),
    ("print(await ", "a Python print around an await"),
    ("global_=True", "a Python keyword argument"),
    ("json.loads", "a Python JSON parse"),
    ("json.dumps", "a Python JSON dump"),
    ("asyncio", "a Python concurrency primitive"),
];

fn markdown_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            markdown_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "md") {
            out.push(path);
        }
    }
}

#[test]
fn skill_documentation_never_teaches_the_python_kernel() {
    let root = skills_dir();
    assert!(
        root.is_dir(),
        "skills directory missing at {}",
        root.display()
    );

    let mut files = Vec::new();
    markdown_files(&root, &mut files);
    assert!(
        files.len() > 10,
        "expected the shipped skill docs, got {files:?}"
    );

    let mut violations = Vec::new();
    for file in files {
        let relative = file
            .strip_prefix(&root)
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/");
        if PYTHON_RUNTIME_DOCS.contains(&relative.as_str()) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&file) else {
            continue;
        };
        for (needle, description) in FORBIDDEN {
            if text.contains(needle) {
                violations.push(format!("{relative}: contains {description} ({needle:?})"));
            }
        }
    }
    assert!(
        violations.is_empty(),
        "skill docs must describe the Bun kernel; found:\n  {}",
        violations.join("\n  ")
    );
}

/// The skills the kernel actually loads must ship a JavaScript entry, so their
/// instructions and their callable form agree.
#[test]
fn executable_skills_ship_a_javascript_entry_point() {
    let root = skills_dir();
    for name in [
        "edit",
        "agent-message",
        "agent-observe",
        "compact",
        "goal",
        "refine",
        "rlm-heartbeat",
        "websearch",
        "attach-image",
    ] {
        let dir = root.join(name);
        assert!(dir.join("index.ts").is_file(), "{name} ships index.ts");
        let manifest = std::fs::read_to_string(dir.join("package.json"))
            .unwrap_or_else(|error| panic!("{name}/package.json: {error}"));
        assert!(
            manifest.contains("\"primeAgent\"") && manifest.contains("\"javascript\""),
            "{name}/package.json declares the JavaScript entry"
        );
    }
}
