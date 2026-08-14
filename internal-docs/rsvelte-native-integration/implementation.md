# Native rsvelte integration implementation

See [design.md](design.md) for goals and trade-offs.

## Data flow

1. `bindingifyInputOptions` inserts a default `rolldown_plugin_rsvelte`, or keeps the configured builtin supplied by the Vite bridge.
2. The configured plugin recognizes component extensions and calls rsvelte directly for client or server output.
3. For client output, while rsvelte's internal arena is alive, `program_to_oxc` builds a `Program` in a Rolldown-owned allocator. Source-independent programs are wrapped in `EcmaAst`; programs with source-dependent spans continue as generated code and are parsed by native OXC.
4. `HookTransformOutput` carries both generated code and the optional native AST through `PluginDriver::transform` and the module loader.
5. `parse_to_ecma_ast` uses the supplied AST or runs the existing parser when no AST survived the transform chain.
6. The existing `transform_ast` hooks and preprocessing run in either case.

## File map

- `crates/rolldown_plugin_rsvelte`: rsvelte compiler adapter and warning/sourcemap conversion.
- `crates/rolldown_plugin/src/types/hook_transform_output.rs`: native AST transport contract.
- `crates/rolldown/src/module_loader` and `crates/rolldown/src/utils/parse_to_ecma_ast.rs`: transport and parser bypass.
- `packages/rolldown/src/utils/bindingify-input-options.ts`: default insertion and configured-builtin de-duplication.
- `crates/rolldown_binding/src/options/plugin/config/binding_rsvelte_plugin_config.rs`: N-API configuration conversion.

## Invariants

- Code and AST must describe the same program.
- A code-changing transform without a replacement AST clears the current AST.
- Failed or source-dependent rsvelte AST conversion falls back to native OXC parsing in the same Rust process, not to the JavaScript compiler.
- OXC crate versions and sources must resolve to one crate identity across rsvelte and Rolldown.

## Vite 8 benchmark harness

`scripts/benchmarks/vite8.mjs` clones pinned Open WebUI and Appwrite Console
commits, installs the official and rsvelte packages side by side, and switches
the two package-resolution points before each build. Reinstall time is outside
the measured interval, and the alternating order prevents one case from always
running with warmer filesystem caches.

The rsvelte case sets `RSVELTE_BENCHMARK_REQUIRE_NATIVE=1`; the staged Vite
plugin throws if either a client or server component reaches its JavaScript
compiler fallback. A completed measurement therefore proves that all `.svelte`
compilation in that production build used the in-process Rust plugin.
Project-specific Vite 8 migration fixtures are applied identically to both
package selections and recorded in the result JSON. Appwrite's
`adapter-static` precompression is disabled in both selections so post-build
gzip/Brotli generation does not dominate the compiler and bundler comparison;
the rest of the adapter still runs.
The runner removes `build` and `.svelte-kit/output` before every trial, hashes
the resulting tree, and reports compressed and canonical file counts
separately. This matters for adapters that create nondeterministic `.gz` and
`.br` files.

The checked-in measurement and machine metadata are in
`benchmarks/vite8/2026-08-15-m1-pro.json`. Installation, Open WebUI's Pyodide
download, and dependency cleanup are not part of build time.

### Profiling

The runner injects a benchmark-only Vite plugin with `enforce: 'post'` and
records `buildStart`, `buildEnd`, `renderStart`, `generateBundle`,
`writeBundle`, and `closeBundle`. Running last is important: otherwise work in
later SvelteKit close hooks is incorrectly classified as time outside Rolldown.
Client builds started by an SSR hook are nested. The reporter splits the
timeline at every boundary and assigns each segment to the smallest active
interval, so a child build is not also counted as time in its parent's hook.
The resulting exclusive phases plus time outside the measured hooks equal the
complete wall-clock build time for every trial.

The staged official and rsvelte Vite plugins also record preprocess call
intervals. The official compile plugin records the same intervals around
`compileSvelte`; the native plugin records client/server file counts, union
wall time, summed worker time, direct-AST handoffs, and same-process native OXC
reparses in Rust. Preprocess and compiler figures are diagnostic subsets of
scan/transform and are not additive phase rows. Rolldown's plugin timing report
is retained in the JSON for diagnosis, but is not used for the compiler result:
it may omit a row below its reporting threshold and inclusive hooks can await a
nested build.
