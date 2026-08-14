# Native rsvelte integration

See [implementation.md](implementation.md) for the data flow and file map.
See [release.md](release.md) for the one-commit rebase and publish workflow.

## Goal

Compile client and server `.svelte` modules inside Rolldown's Rust process, without invoking the JavaScript Svelte compiler or transferring the compiler invocation and result across a Rust-JavaScript boundary. When rsvelte produces a source-independent OXC AST, hand it directly to the scanner. Otherwise Rolldown parses rsvelte's generated JavaScript with native OXC in the same Rust process.

## Decisions

- The JavaScript option bridge inserts a default rsvelte builtin unless the Vite integration already supplied one. Replacing the dependency is sufficient for direct usage.
- Compiler settings flow only through the existing `@rsvelte/vite-plugin-svelte` interface. Rolldown exposes no rsvelte-specific public option or plugin API.
- Direct Rolldown usage injects component CSS because Rolldown v1.2.4 does not bundle CSS. The Vite bridge uses virtual CSS modules handled by Vite's CSS pipeline.
- The native AST is attached to a transform result. Any later transform that replaces the code without providing a matching AST invalidates it and restores the normal parser path.
- rsvelte is pinned as a non-recursive submodule until its Rust crates are published. This avoids Cargo recursively fetching rsvelte's corpus submodules.

## Compatibility boundary

The Vite bridge uses native rsvelte compilation for static client and server production builds. Development/HMR, callback-based configuration, custom warning handlers, and `.svelte.js` / `.svelte.ts` module compilation remain outside this integration. rsvelte's client AST converter is intentionally fallible, and converted trees with source-dependent spans are not safe to attach to generated code. In those cases Rolldown parses the generated JavaScript with native OXC in the same Rust process. This is still a native-only compiler path; it does not call `svelte/compiler` or cross the N-API boundary per component.

Vite and SvelteKit themselves still execute in Node.js. This integration removes the per-component compiler boundary; it does not turn the complete Vite application pipeline or arbitrary JavaScript plugins into a standalone Rust executable. Configured JavaScript preprocessors remain JavaScript transforms before native compilation.
