# Branch and release operation

`main` tracks upstream Rolldown. `rsvelte-rolldown` contains one integration
commit on top of an upstream release tag. Publishing belongs to this
repository because rsvelte is statically linked into every Rolldown native
binding.

## Release flow

Add a patch changeset for every releasable integration change:

```sh
pnpm changeset
```

Pushing `rsvelte-rolldown` causes `.github/workflows/release.yml` to open or
refresh the `chore(release): version packages` pull request. Merging that pull
request:

1. builds all 15 native binding packages and the Node package;
2. verifies the package tarballs;
3. publishes `@rsvelte/rolldown` and `@rsvelte/rolldown-binding-*` with npm
   trusted publishing;
4. creates the immutable Changesets release tag; and
5. safely folds the release metadata back into the branch's integration
   commit with an exact `--force-with-lease`.

The last step preserves the one-commit branch invariant. It stops instead of
overwriting the branch if another push arrived during publishing. Do not
manually merge a Version Packages pull request with a different commit
message; the release workflow uses its generated
`chore(release): version packages` message to select the publish path.

The GitHub repository must have an environment named `release`. No
`NPM_TOKEN` is stored: the workflow uses GitHub OIDC and npm trusted
publishing.

## First publication

npm only allows a trusted publisher to be attached after a package name
exists. On the first push, the release workflow therefore builds artifacts
even before the Version Packages pull request is merged. After that build
finishes, bootstrap every package name from a maintainer machine authenticated
to npm:

```sh
pnpm run bootstrap-npm-packages -- --run <github-actions-run-id>
pnpm run bootstrap-npm-packages -- --run <github-actions-run-id> --yes
```

The first command is a dry run. The second is the irreversible publish and is
idempotent after a partial failure. The script refuses to publish a new
version of any package name that already exists; established packages must go
through the OIDC workflow.

After bootstrap, configure the trusted publisher on npmjs.com for
`@rsvelte/rolldown` and every generated `@rsvelte/rolldown-binding-*` package:

- owner: `baseballyama`
- repository: `rsvelte-rolldown`
- workflow: `release.yml`
- environment: `release`
- allowed action: `npm publish`

Then merge the Version Packages pull request. Subsequent releases need no
local npm credentials.

## Rebase onto a new Rolldown release

```sh
git fetch upstream --tags
git switch rsvelte-rolldown
git rebase --onto v1.2.5 v1.2.4
```

Resolve conflicts, update `packages/rolldown/package.json` to
`1.2.5-rsvelte.0`, and keep `.changeset/pre.json` in the `rsvelte` prerelease
mode. Update the pinned rsvelte submodule when required, amend the integration
commit, add a patch changeset, and push with `--force-with-lease`.

Changesets remains permanently in the `rsvelte` prerelease channel. A patch
changeset therefore advances integration revisions as
`1.2.5-rsvelte.0` → `1.2.5-rsvelte.1` while retaining the exact upstream
Rolldown base in the version.
