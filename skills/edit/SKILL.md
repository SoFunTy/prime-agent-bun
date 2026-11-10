---
name: edit
description: Replace an exact, unique string in an existing file. Use for targeted single-occurrence edits to files from the kernel instead of rewriting the whole file.
---

# Edit

Make a targeted edit to an existing file by replacing one exact, unique
occurrence of a string. `old_str` must appear exactly once in the file.

Call directly from the kernel with one options object:

```js
await edit({ path: "src/app.ts", old_str: old, new_str: new });
```

Use exact old/new strings. Build `old` from an inspected file slice when the text
is awkward to inline (template literals carry quotes and newlines):

```js
const source = await Bun.file("src/app.ts").text();
const old = source.slice(start, end);
await edit({ path: "src/app.ts", old_str: old, new_str: replacement });
```

Returns a short confirmation and emits the diff to the transcript; raises if
`old_str` is missing or matches more than once (widen the snippet to make it
unique).

Or from a shell cell:

    !edit --path src/app.ts --old-str "..." --new-str "..."
