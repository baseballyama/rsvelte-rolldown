#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const usage = `Usage:
  pnpm run bootstrap-npm-packages -- --run <github-actions-run-id>
  pnpm run bootstrap-npm-packages -- --run <github-actions-run-id> --yes [--otp <code>]

The default mode downloads the release artifacts and runs npm publish --dry-run.
Pass --yes only for the one-time creation of new npm package names.`;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const packageDir = join(repoRoot, 'packages/rolldown');
const artifactsDir = join(packageDir, 'artifacts');
const npmDir = join(packageDir, 'npm');
const argv = process.argv.slice(2);

class BootstrapError extends Error {}

function fail(message) {
  throw new BootstrapError(message);
}

function flag(name) {
  return argv.includes(`--${name}`);
}

function option(name) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) fail(`--${name} requires a value`);
  return value;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

function runOrFail(command, args, options = {}) {
  const result = run(command, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) {
    fail(`\`${command} ${args.join(' ')}\` failed`);
  }
}

function requireTool(command, args) {
  const result = run(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) {
    fail(`\`${command} ${args.join(' ')}\` failed — is ${command} installed and authenticated?`);
  }
  return result.stdout.trim();
}

function registryLookup(specifier) {
  const result = run('npm', ['view', specifier, 'version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 0) return result.stdout.trim();
  if (`${result.stdout}\n${result.stderr}`.includes('E404')) return undefined;
  fail(`could not determine whether ${specifier} exists on npm`);
}

try {
  const runId = option('run');
  const publishForReal = flag('yes');
  const otp = option('otp');
  if (flag('help')) {
    console.log(usage);
    process.exit(0);
  }
  if (!runId) {
    console.error(usage);
    process.exit(1);
  }

  requireTool('gh', ['auth', 'status']);
  if (publishForReal) {
    console.log(`[bootstrap] npm user: ${requireTool('npm', ['whoami'])}`);
  }
  console.log(`[bootstrap] source run: ${runId}`);
  console.log(`[bootstrap] mode: ${publishForReal ? 'PUBLISH' : 'dry-run'}`);

  if (existsSync(artifactsDir) || existsSync(npmDir)) {
    fail('packages/rolldown/artifacts and packages/rolldown/npm must not exist before bootstrap');
  }

  const staging = mkdtempSync(join(tmpdir(), 'rsvelte-rolldown-bootstrap-'));
  try {
    const bindingDownload = join(staging, 'bindings');
    const nodeDownload = join(staging, 'node');
    runOrFail('gh', [
      'run',
      'download',
      runId,
      '--repo',
      'baseballyama/rsvelte-rolldown',
      '--pattern',
      'bindings-*',
      '--dir',
      bindingDownload,
    ]);
    runOrFail('gh', [
      'run',
      'download',
      runId,
      '--repo',
      'baseballyama/rsvelte-rolldown',
      '--name',
      'node-artifact',
      '--dir',
      nodeDownload,
    ]);

    cpSync(bindingDownload, artifactsDir, { recursive: true });
    cpSync(nodeDownload, join(packageDir, 'dist'), { recursive: true, force: true });
    runOrFail('pnpm', ['--filter', '@rsvelte/rolldown', 'exec', 'napi', 'create-npm-dirs']);
    runOrFail('pnpm', ['--filter', '@rsvelte/rolldown', 'run', 'artifacts']);

    const mainManifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    const platformDirs = readdirSync(npmDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(npmDir, entry.name));
    if (platformDirs.length !== mainManifest.napi.targets.length) {
      fail(
        `expected ${mainManifest.napi.targets.length} platform packages, found ${platformDirs.length}`,
      );
    }

    for (const destination of [packageDir, ...platformDirs]) {
      copyFileSync(join(repoRoot, 'LICENSE'), join(destination, 'LICENSE'));
      copyFileSync(join(repoRoot, 'THIRD-PARTY-LICENSE'), join(destination, 'THIRD-PARTY-LICENSE'));
    }

    const packages = [...platformDirs, packageDir].map((directory) => {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      return { directory, name: manifest.name, version: manifest.version };
    });
    const plan = [];
    for (const pkg of packages) {
      const exactVersion = registryLookup(`${pkg.name}@${pkg.version}`);
      if (exactVersion === pkg.version) {
        console.log(`[bootstrap] ${pkg.name}@${pkg.version} already published — skipping`);
        continue;
      }
      if (registryLookup(pkg.name)) {
        fail(`${pkg.name} already exists; publish new versions through the OIDC release workflow`);
      }
      plan.push(pkg);
    }

    if (plan.length === 0) {
      console.log('[bootstrap] nothing to publish');
    } else {
      let failures = 0;
      for (const pkg of plan) {
        console.log(
          `[bootstrap] publishing ${pkg.name}@${pkg.version}${publishForReal ? '' : ' (dry-run)'}`,
        );
        const args = ['publish', '--access', 'public'];
        if (!publishForReal) args.push('--dry-run');
        if (otp) args.push('--otp', otp);
        const env =
          pkg.directory === packageDir ? { ...process.env, NAPI_DRY_RUN: '1' } : process.env;
        const result = run('npm', args, { cwd: pkg.directory, env, stdio: 'inherit' });
        if (result.status !== 0) {
          console.error(`[bootstrap] FAILED: ${pkg.name}@${pkg.version}`);
          failures += 1;
        }
      }
      if (failures > 0) fail(`${failures} package(s) failed`);

      if (publishForReal) {
        console.log(
          '\n[bootstrap] done. Add the release.yml trusted publisher with the release environment to every new package.',
        );
      } else {
        console.log('\n[bootstrap] dry run only — re-run with --yes to publish.');
      }
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(artifactsDir, { recursive: true, force: true });
    rmSync(npmDir, { recursive: true, force: true });
  }
} catch (error) {
  if (error instanceof BootstrapError) {
    console.error(`[bootstrap] ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
