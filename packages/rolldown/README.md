# @rsvelte/rolldown

[![npm version](https://img.shields.io/npm/v/%40rsvelte%2Frolldown/latest?color=brightgreen)](https://www.npmjs.com/package/@rsvelte/rolldown)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/baseballyama/rsvelte-rolldown/blob/rsvelte-rolldown/LICENSE)

A Rolldown distribution with
[rsvelte](https://github.com/baseballyama/rsvelte) built in as a native plugin.

Client and server `.svelte` components are compiled inside Rolldown's Rust
process. The compiler invocation and result do not cross the per-component
Rust-JavaScript boundary. Source-independent client programs are passed to
Rolldown as OXC ASTs; other generated programs are parsed by native OXC in the
same process.

## Usage

### Vite 8

Add a pnpm override for Vite's transitive Rolldown dependency:

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

Run `pnpm install`. Keep the existing Vite plugin interface and configuration:

```js
import { defineConfig } from 'vite';
import { svelte } from '@rsvelte/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
});
```

When migrating from the official Svelte plugin too, alias its existing package
name so application and SvelteKit imports stay unchanged:

```diff
   "devDependencies": {
-    "@sveltejs/vite-plugin-svelte": "^7.0.0",
+    "@sveltejs/vite-plugin-svelte": "npm:@rsvelte/vite-plugin-svelte@latest",
     "svelte": "^5.0.0",
     "vite": "^8.0.0"
   }
```

### Rolldown

Replace the package behind an existing Rolldown dependency:

```diff
 {
   "devDependencies": {
-    "rolldown": "^1.2.4"
+    "rolldown": "npm:@rsvelte/rolldown@latest"
   }
 }
```

Existing imports and configuration remain unchanged:

```js
import { defineConfig } from 'rolldown';

export default defineConfig({
  input: 'src/App.svelte',
});
```

rsvelte is enabled automatically. No rsvelte plugin import or configuration is
required.

In Vite, keep compiler and preprocessor settings on the existing
`svelte({ ... })` plugin. The Vite plugin forwards them internally;
`@rsvelte/rolldown` adds no public configuration surface of its own.

Static client and server production builds compile through the native Rust
plugin. Development/HMR, callback options, custom warning handlers, and dynamic
compiler options retain the Vite plugin's existing N-API path.

Direct builds inject component CSS, while the Vite bridge emits virtual CSS
modules for Vite's CSS pipeline. Programs that cannot safely carry rsvelte's
OXC AST are parsed by native OXC in the same Rust process, not by the JavaScript
Svelte compiler. `.svelte.js` / `.svelte.ts` compilation is not included yet.

Vite and SvelteKit still run in Node.js; this package removes the component
compiler boundary rather than replacing the complete JavaScript plugin runtime.
Configured JavaScript preprocessors remain JavaScript transforms before native
compilation.

Package versions retain their Rolldown base, for example
`1.2.4-rsvelte.0`. Source, limitations, and release details are available in
the [`rsvelte-rolldown` repository](https://github.com/baseballyama/rsvelte-rolldown/tree/rsvelte-rolldown).

This distribution is maintained independently and builds on
[Rolldown](https://github.com/rolldown/rolldown) and
[rsvelte](https://github.com/baseballyama/rsvelte).
