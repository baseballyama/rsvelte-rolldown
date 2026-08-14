# @rsvelte/rolldown

[![npm version](https://img.shields.io/npm/v/%40rsvelte%2Frolldown/latest?color=brightgreen)](https://www.npmjs.com/package/@rsvelte/rolldown)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Rolldown distribution with
[rsvelte](https://github.com/baseballyama/rsvelte) built in as a native plugin.

Client and server `.svelte` components are compiled inside Rolldown's Rust
process. The compiler invocation and result do not cross the Rust-JavaScript
boundary. When a generated client program has source-independent spans, its OXC
AST is handed directly to Rolldown; otherwise the generated JavaScript is parsed
by native OXC in the same process.

## Usage

### Migrate an existing Vite 8 project

If the project already uses `@rsvelte/vite-plugin-svelte`, override Vite's
transitive `rolldown` dependency in `package.json`:

```diff
 {
   "devDependencies": {
     "@rsvelte/vite-plugin-svelte": "latest",
     "svelte": "^5.0.0",
     "vite": "^8.0.0"
+  },
+  "pnpm": {
+    "overrides": {
+      "rolldown": "npm:@rsvelte/rolldown@latest"
+    }
   }
 }
```

Run `pnpm install`. The existing Vite configuration does not change:

```js
import { defineConfig } from 'vite';
import { svelte } from '@rsvelte/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
});
```

When migrating from the official Svelte plugin too, alias the existing package
name so imports and configuration remain unchanged:

```diff
   "devDependencies": {
-    "@sveltejs/vite-plugin-svelte": "^7.0.0",
+    "@sveltejs/vite-plugin-svelte": "npm:@rsvelte/vite-plugin-svelte@latest",
     "svelte": "^5.0.0",
     "vite": "^8.0.0"
   }
```

Existing imports such as
`import { svelte } from '@sveltejs/vite-plugin-svelte'` do not change. This
also satisfies SvelteKit's peer dependency under the package name it expects.

Static client and server production builds use native rsvelte compilation.
Development/HMR, `dynamicCompileOptions`, callback compiler options, and custom
`onwarn` handlers retain the Vite plugin's existing N-API compilation path.

### Migrate an existing Rolldown project

Replace the package behind the existing `rolldown` dependency:

```diff
 {
   "devDependencies": {
-    "rolldown": "^1.2.4"
+    "rolldown": "npm:@rsvelte/rolldown@latest"
   }
 }
```

After `pnpm install`, existing imports and configuration remain unchanged:

```js
import { defineConfig } from 'rolldown';

export default defineConfig({
  input: 'src/App.svelte',
});
```

rsvelte is enabled automatically. No rsvelte plugin import or configuration is
required.

In Vite, keep all compiler and preprocessor settings on the existing
`svelte({ ... })` plugin. `@rsvelte/vite-plugin-svelte` resolves and forwards
them to the native integration; `@rsvelte/rolldown` adds no public configuration
surface of its own.

## Integration behavior

- Client and server `.svelte` components are compiled by rsvelte in Rust.
- Component CSS is injected for direct Rolldown builds. The Vite bridge emits
  virtual CSS modules for Vite's CSS pipeline.
- A later transform that changes the generated code invalidates the native AST
  and restores Rolldown's normal parser path.
- Programs that cannot safely carry rsvelte's OXC AST, including
  comment-coordinate and source-span cases, are parsed by native OXC in the
  same Rust process. This is not a fallback to the JavaScript Svelte compiler.
- `.svelte.js` / `.svelte.ts` module compilation is not included yet.

Vite and SvelteKit still run in Node.js. The integration removes the
per-component compiler boundary; it does not turn the rest of Vite or arbitrary
JavaScript plugins into a standalone Rust executable. Configured JavaScript
preprocessors also remain JavaScript transforms before native compilation.

## Vite 8 production-bundle benchmark

The native compiler path was measured on two pinned real-world SvelteKit
applications. The primary statistic is the median of five production builds
after one warm-up per case; trials alternate between the official and rsvelte
packages. Appwrite's adapter-static precompression is disabled in both cases so
post-build gzip/Brotli generation does not obscure the compiler and bundler
comparison. All other adapter work remains enabled.

| Project                                                 | `.svelte` files | Vite 8 + Rolldown | Vite 8 + rsvelte-rolldown | Median change |
| ------------------------------------------------------- | --------------: | ----------------: | ------------------------: | ------------: |
| [Open WebUI](https://github.com/open-webui/open-webui)  |             650 |          17.595 s |                   9.737 s |  44.7% faster |
| [Appwrite Console](https://github.com/appwrite/console) |           1,011 |          21.276 s |                  13.694 s |  35.6% faster |

Open WebUI is 1.807x faster and Appwrite Console is 1.554x faster by median.
These are complete SvelteKit bundle times apart from the explicitly excluded
precompression step, so they still include dependency transforms, CSS,
minification, SSR, prerendering, adapter work, and asset copying. They are not
compiler-only numbers.

### Where the remaining time goes

The benchmark also records nested client and server builds at Vite/Rolldown
hook boundaries. The following is the rsvelte trial closest to each five-run
median. The rows are exclusive and add up to the complete build time.

The first row covers module-graph construction from `buildStart` through
`buildEnd`. Rolldown discovers dependencies; resolves and loads each module;
runs Vite plugin transforms, including Svelte preprocessors and the Svelte
compiler; creates or receives an OXC AST; and scans imports, exports, symbols,
and side effects. Svelte compilation is part of this row, not a separate phase
that should be added to it.

| Exclusive phase                         |  Open WebUI |    Share | Appwrite Console |    Share |
| --------------------------------------- | ----------: | -------: | ---------------: | -------: |
| Build module graph (includes Svelte)    |     4.134 s |    42.5% |         10.174 s |    74.3% |
| Link                                    |     0.632 s |     6.5% |          0.178 s |     1.3% |
| Generate chunks                         |     1.310 s |    13.5% |          0.816 s |     6.0% |
| Write output                            |     1.686 s |    17.3% |          0.741 s |     5.4% |
| Close hooks and adapter work            |     1.350 s |    13.9% |          0.903 s |     6.6% |
| Vite startup/config outside these hooks |     0.625 s |     6.4% |          0.881 s |     6.4% |
| **Total**                               | **9.737 s** | **100%** |     **13.694 s** | **100%** |

Appwrite's largest remaining cost is its configured `svelte-preprocess` and
Melt UI preprocessing: 8.593 s, or 62.7% of the representative build. Open
WebUI preprocessing takes 0.818 s (8.4%). Preprocessing and compiler times are
diagnostic subsets of module-graph construction, so they must not be added to
the exclusive rows.

Measured in isolation inside module-graph construction, replacing the
JavaScript compiler is substantially faster:

| Project          | Official Svelte compile | Native rsvelte compile | Compiler speedup | Native share of full build |
| ---------------- | ----------------------: | ---------------------: | ---------------: | -------------------------: |
| Open WebUI       |                 7.612 s |                0.809 s |            9.41x |                       8.3% |
| Appwrite Console |                 7.063 s |                1.972 s |            3.58x |                      14.4% |

These are merged wall-clock intervals across both the client and server
compilations, not sums of parallel worker durations. Open WebUI compiles 878
components for each target; Appwrite compiles 1,789. No component crosses the
Rust-JavaScript boundary in the rsvelte case. For client output, 9 of 878 Open
WebUI programs and 715 of 1,789 Appwrite programs are handed to Rolldown as a
direct OXC AST. The remainder are reparsed by OXC inside the same Rust process
because they retain source-dependent spans. Improving that AST handoff can
reduce the native compiler slice, but that slice is already only 8–14% of the
measured build and therefore cannot make the whole SvelteKit build 10x faster.

The rsvelte case aborts if either client or server compilation reaches the
JavaScript compiler fallback. Every recorded rsvelte build therefore compiled
all `.svelte` files inside the Rust plugin. Output fingerprints are recorded for
every trial; this is a performance benchmark rather than an output-parity gate.

The recorded environment was a 10-core Apple M1 Pro with 32 GiB RAM, Darwin
25.5.0, Node 25.7.0, npm 11.10.1, and Bun 1.3.10. Versions were fixed at Vite
8.2.1, Svelte 5.56.8, Rolldown 1.2.4, and
`@sveltejs/vite-plugin-svelte` 7.3.0. Full trial arrays, source commits, fixture
adjustments, and output checks are in the
[recorded result](benchmarks/vite8/2026-08-15-m1-pro.json).

Reproduce it from this repository after `@rsvelte/rolldown` is published:

```sh
node scripts/benchmarks/vite8.mjs --runs 5 --warmups 1
```

To test an unpublished local release build instead:

```sh
node scripts/benchmarks/vite8.mjs \
  --runs 5 \
  --warmups 1 \
  --rsvelte-rolldown-dir packages/rolldown
```

The runner clones exact source commits, applies the same documented Vite 8
migration fixtures to both cases, excludes dependency installation and Open
WebUI's network-only Pyodide fetch from timing, cleans build outputs before
every trial, records every duration and output fingerprint as JSON, and removes
each project's dependencies before continuing to limit disk usage.
Benchmark-only hooks record exclusive Rolldown phases, Svelte preprocess calls,
exact official compiler intervals, and the native compiler's wall and worker
time.

See the [design](internal-docs/rsvelte-native-integration/design.md),
[implementation](internal-docs/rsvelte-native-integration/implementation.md),
and [release operation](internal-docs/rsvelte-native-integration/release.md)
documents for details.

## Versioning and maintenance

Versions retain the Rolldown version they are based on:

```text
Rolldown v1.2.4 -> @rsvelte/rolldown 1.2.4-rsvelte.0
```

The `main` branch tracks upstream Rolldown. The `rsvelte-rolldown` branch keeps
one integration commit on top of a Rolldown release and is rebased when a new
Rolldown release is available. Changesets maintains a Version Packages pull
request on that branch. Merging it builds and publishes every native package,
then folds the release metadata back into the integration commit. Published
releases remain available through immutable
`@rsvelte/rolldown@*-rsvelte.*` tags.

## Related projects

This project is maintained independently and is built on:

- [rolldown/rolldown](https://github.com/rolldown/rolldown), the upstream
  JavaScript bundler
- [baseballyama/rsvelte](https://github.com/baseballyama/rsvelte), the Rust
  Svelte compiler

General Rolldown documentation is available at [rolldown.rs](https://rolldown.rs/).
Issues specific to this native integration should be reported in this
repository.

## License

This repository is licensed under the [MIT License](LICENSE). Licenses for
included and derived work are recorded in
[THIRD-PARTY-LICENSE](THIRD-PARTY-LICENSE).
