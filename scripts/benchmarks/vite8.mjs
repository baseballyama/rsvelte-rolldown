#!/usr/bin/env node

// See internal-docs/rsvelte-native-integration/implementation.md.
import { createHash } from 'node:crypto';
import {
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDir, '../..');

const versions = {
  vite: '8.2.1',
  svelte: '5.56.8',
  rolldown: '1.2.4',
  officialPlugin: '7.3.0',
  rsvelteRolldown: '1.2.4-rsvelte.0',
  rsveltePluginSourceCommit: '3c67cd091c4e4aea2d1e38066cdb7eab7b40a6dd',
};

const projects = [
  {
    id: 'open-webui',
    name: 'Open WebUI',
    repository: 'https://github.com/open-webui/open-webui.git',
    commit: '01f4282f1ffe0d6212f58d3afbeae21fffd0c4be',
    packageManager: 'npm',
    build: ['node', 'node_modules/vite/bin/vite.js', 'build'],
    outputs: ['build'],
  },
  {
    id: 'appwrite-console',
    name: 'Appwrite Console',
    repository: 'https://github.com/appwrite/console.git',
    commit: '8c1b58a6d252fee7ab8798e256aad858c89dc99f',
    packageManager: 'bun',
    build: ['node', 'build.js'],
    outputs: ['build'],
  },
];

const cases = {
  official: {
    label: 'Vite 8 (Rolldown)',
    expectedPluginName: '@sveltejs/vite-plugin-svelte',
    expectedRolldownName: 'rolldown',
  },
  rsvelte: {
    label: 'Vite 8 (rsvelte-rolldown)',
    expectedPluginName: '@rsvelte/vite-plugin-svelte',
    expectedRolldownName: '@rsvelte/rolldown',
  },
};

function usage() {
  console.log(`Usage: node scripts/benchmarks/vite8.mjs [options]

Options:
  --runs <n>                         Measured builds per case (default: 5)
  --warmups <n>                      Warm-up builds per case (default: 1)
  --project <id[,id]>                open-webui, appwrite-console, or both
  --work-dir <path>                  Clone/install directory (default: OS temp)
  --output <path>                    Result JSON path
  --rsvelte-rolldown <npm-spec>      Package spec (default: exact npm release)
  --rsvelte-rolldown-dir <path>      Use a locally built package instead
  --rsvelte-plugin-dir <path>        Use a local plugin source directory
  --keep-dependencies                Keep each project's node_modules after it runs
  --help                             Show this message

The local Rolldown directory must contain dist plus a release .node binding.
The pinned source fallback for the rsvelte Vite plugin is reproducible from
rsvelte commit 3c67cd091c4e4aea2d1e38066cdb7eab7b40a6dd.`);
}

function parseArguments(argv) {
  const options = {
    runs: 5,
    warmups: 1,
    projectIds: projects.map((project) => project.id),
    workDir: join(tmpdir(), 'rsvelte-rolldown-vite8-benchmark'),
    output: resolve(repositoryRoot, 'tmp/benchmarks/vite8/latest.json'),
    rsvelteRolldown: `@rsvelte/rolldown@${versions.rsvelteRolldown}`,
    rsvelteRolldownDir: undefined,
    rsveltePluginDir: undefined,
    keepDependencies: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${argument} requires a value`);
      index += 1;
      return next;
    };

    if (argument === '--help') {
      usage();
      process.exit(0);
    } else if (argument === '--runs') {
      options.runs = parseCount(value(), '--runs', 1);
    } else if (argument === '--warmups') {
      options.warmups = parseCount(value(), '--warmups', 0);
    } else if (argument === '--project') {
      options.projectIds = value().split(',');
    } else if (argument === '--work-dir') {
      options.workDir = resolve(value());
    } else if (argument === '--output') {
      options.output = resolve(value());
    } else if (argument === '--rsvelte-rolldown') {
      options.rsvelteRolldown = value();
    } else if (argument === '--rsvelte-rolldown-dir') {
      options.rsvelteRolldownDir = resolve(value());
    } else if (argument === '--rsvelte-plugin-dir') {
      options.rsveltePluginDir = resolve(value());
    } else if (argument === '--keep-dependencies') {
      options.keepDependencies = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  const knownProjects = new Set(projects.map((project) => project.id));
  for (const projectId of options.projectIds) {
    if (!knownProjects.has(projectId)) throw new Error(`Unknown project: ${projectId}`);
  }
  return options;
}

function parseCount(value, flag, minimum) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < minimum) {
    throw new Error(`${flag} must be an integer >= ${minimum}`);
  }
  return count;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    stdio: options.inherit ? 'inherit' : 'pipe',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${tail(output, 80)}`);
  }
  return (result.stdout ?? '').trim();
}

function tail(value, lineCount) {
  return value.split('\n').slice(-lineCount).join('\n');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function assertInside(parent, target) {
  const relativePath = relative(resolve(parent), resolve(target));
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`Refusing to modify path outside ${parent}: ${target}`);
  }
}

function removeGenerated(parent, target) {
  assertInside(parent, target);
  rmSync(target, { recursive: true, force: true });
}

function cloneProject(project, workDir) {
  const projectDir = join(workDir, 'projects', project.id);
  if (!existsSync(join(projectDir, '.git'))) {
    mkdirSync(dirname(projectDir), { recursive: true });
    run('git', ['clone', '--filter=blob:none', '--no-checkout', project.repository, projectDir], {
      inherit: true,
    });
  }
  run('git', ['fetch', '--depth=1', 'origin', project.commit], {
    cwd: projectDir,
    inherit: true,
  });
  run('git', ['checkout', '--detach', '--force', project.commit], {
    cwd: projectDir,
  });
  const actualCommit = run('git', ['rev-parse', 'HEAD'], { cwd: projectDir });
  if (actualCommit !== project.commit) throw new Error(`Unexpected commit for ${project.id}`);
  return projectDir;
}

function stageLocalRolldown(sourceDir, workDir) {
  const source = resolve(sourceDir);
  const packageJsonPath = join(source, 'package.json');
  const distDir = join(source, 'dist');
  if (!existsSync(packageJsonPath) || !existsSync(distDir)) {
    throw new Error(`Local Rolldown package is not built: ${source}`);
  }
  const bindings = findFiles(distDir, (path) => path.endsWith('.node'));
  if (bindings.length === 0) {
    throw new Error(`Local Rolldown package has no release .node binding under ${distDir}`);
  }

  const destination = join(workDir, 'packages', 'rsvelte-rolldown');
  removeGenerated(workDir, destination);
  mkdirSync(destination, { recursive: true });
  for (const entry of ['bin', 'cli', 'dist', 'LICENSE', 'THIRD-PARTY-LICENSE']) {
    const sourcePath = join(source, entry);
    if (existsSync(sourcePath)) cpSync(sourcePath, join(destination, entry), { recursive: true });
  }
  const packageJson = readJson(packageJsonPath);
  packageJson.dependencies = {
    '@oxc-project/types': '=0.144.0',
    '@rolldown/pluginutils': '^1.0.0',
  };
  packageJson.devDependencies = {};
  packageJson.scripts = {};
  writeJson(join(destination, 'package.json'), packageJson);
  return `file:${destination}`;
}

function stageLocalPlugin(sourceDir, workDir) {
  const source = resolve(sourceDir);
  const packageJsonPath = join(source, 'package.json');
  if (!existsSync(packageJsonPath) || !existsSync(join(source, 'src/plugins/native-compile.js'))) {
    throw new Error(`Local rsvelte Vite plugin lacks the native bridge: ${source}`);
  }
  const destination = join(workDir, 'packages', 'rsvelte-vite-plugin-svelte');
  removeGenerated(workDir, destination);
  mkdirSync(destination, { recursive: true });
  for (const entry of ['src', 'types', 'LICENSE', 'README.md']) {
    const sourcePath = join(source, entry);
    if (existsSync(sourcePath)) cpSync(sourcePath, join(destination, entry), { recursive: true });
  }
  for (const path of findFiles(join(destination, 'src'), (path) => path.endsWith('.js'))) {
    const source = readFileSync(path, 'utf8');
    writeFileSync(
      path,
      source.replaceAll("'@rsvelte/vite-plugin-svelte-native'", "'svelte/compiler'"),
    );
  }
  const compilePluginPath = join(destination, 'src/plugins/compile.js');
  const compilePlugin = readFileSync(compilePluginPath, 'utf8');
  const consumerCheck = "const ssr = this.environment.config.consumer === 'server';";
  if (!compilePlugin.includes(consumerCheck)) {
    throw new Error('rsvelte Vite fallback guard patch no longer applies');
  }
  writeFileSync(
    compilePluginPath,
    compilePlugin.replace(
      consumerCheck,
      `${consumerCheck}\n\t\t\t\tif (process.env.RSVELTE_BENCHMARK_REQUIRE_NATIVE === '1') {\n\t\t\t\t\tthrow new Error(\`rsvelte benchmark reached the JavaScript \${ssr ? 'server' : 'client'} fallback\`);\n\t\t\t\t}`,
    ),
  );
  const packageJson = readJson(packageJsonPath);
  delete packageJson.dependencies['@rsvelte/vite-plugin-svelte-native'];
  packageJson.devDependencies = {};
  packageJson.scripts = {};
  writeJson(join(destination, 'package.json'), packageJson);
  return `file:${destination}`;
}

function preparePinnedPlugin(workDir) {
  const pinnedCommit = versions.rsveltePluginSourceCommit;
  const vendored = join(repositoryRoot, 'vendor/rsvelte');
  if (
    existsSync(join(vendored, '.git')) &&
    run('git', ['rev-parse', 'HEAD'], { cwd: vendored }) === pinnedCommit
  ) {
    return stageLocalPlugin(join(vendored, 'apps/npm/vite-plugin-svelte'), workDir);
  }

  const checkout = join(workDir, 'sources', 'rsvelte');
  if (!existsSync(join(checkout, '.git'))) {
    mkdirSync(dirname(checkout), { recursive: true });
    run(
      'git',
      [
        'clone',
        '--filter=blob:none',
        '--no-checkout',
        'https://github.com/baseballyama/rsvelte.git',
        checkout,
      ],
      { inherit: true },
    );
  }
  run('git', ['fetch', '--depth=1', 'origin', pinnedCommit], {
    cwd: checkout,
    inherit: true,
  });
  run('git', ['checkout', '--detach', '--force', pinnedCommit], {
    cwd: checkout,
  });
  return stageLocalPlugin(join(checkout, 'apps/npm/vite-plugin-svelte'), workDir);
}

function restoreTrackedFile(projectDir, commit, path) {
  const contents = run('git', ['show', `${commit}:${path}`], {
    cwd: projectDir,
  });
  writeFileSync(join(projectDir, path), `${contents}\n`);
}

function prepareManifest(project, projectDir, packageSpecs) {
  restoreTrackedFile(projectDir, project.commit, 'package.json');
  const packageJsonPath = join(projectDir, 'package.json');
  const packageJson = readJson(packageJsonPath);
  packageJson.devDependencies ??= {};
  packageJson.devDependencies.vite = versions.vite;
  packageJson.devDependencies.svelte = versions.svelte;
  packageJson.devDependencies['@sveltejs/vite-plugin-svelte'] = versions.officialPlugin;
  packageJson.devDependencies['@rsvelte/vite-plugin-svelte'] = packageSpecs.plugin;
  packageJson.devDependencies['@sveltejs/vite-plugin-svelte-inspector'] = '5.0.2';
  packageJson.devDependencies.rolldown = versions.rolldown;
  packageJson.devDependencies['@rsvelte/rolldown'] = packageSpecs.rolldown;
  if (project.id === 'open-webui') {
    packageJson.devDependencies['vite-plugin-static-copy'] = '4.1.1';
    packageJson.devDependencies['@internationalized/date'] = '3.12.3';
  }
  if (packageJson.overrides) delete packageJson.overrides.vite;
  writeJson(packageJsonPath, packageJson);

  if (project.id === 'open-webui') {
    restoreTrackedFile(projectDir, project.commit, 'svelte.config.js');
    const configPath = join(projectDir, 'svelte.config.js');
    const config = readFileSync(configPath, 'utf8');
    const onwarn = `,\n\tonwarn: (warning, handler) => {\n\t\tconst { code } = warning;\n\t\tif (code === 'css-unused-selector') return;\n\n\t\thandler(warning);\n\t}`;
    if (!config.includes(onwarn))
      throw new Error('Open WebUI onwarn fixture patch no longer applies');
    const withoutOnwarn = config.replace(onwarn, '');
    const kitProperty = '\tkit: {';
    if (!withoutOnwarn.includes(kitProperty)) {
      throw new Error('Open WebUI compilerOptions fixture patch no longer applies');
    }
    writeFileSync(
      configPath,
      withoutOnwarn.replace(
        kitProperty,
        '\tcompilerOptions: { preserveComments: false },\n' + kitProperty,
      ),
    );

    restoreTrackedFile(projectDir, project.commit, 'vite.config.ts');
    const viteConfigPath = join(projectDir, 'vite.config.ts');
    const viteConfig = readFileSync(viteConfigPath, 'utf8');
    if (!viteConfig.includes('sourcemap: true')) {
      throw new Error('Open WebUI sourcemap fixture patch no longer applies');
    }
    writeFileSync(viteConfigPath, viteConfig.replace('sourcemap: true', 'sourcemap: false'));

    restoreTrackedFile(projectDir, project.commit, 'src/tailwind.css');
    const tailwindPath = join(projectDir, 'src/tailwind.css');
    const tailwind = readFileSync(tailwindPath, 'utf8');
    if (!tailwind.startsWith("@import 'tailwindcss';")) {
      throw new Error('Open WebUI Tailwind fixture patch no longer applies');
    }
    writeFileSync(
      tailwindPath,
      tailwind.replace(
        "@import 'tailwindcss';",
        "@import '../node_modules/tailwindcss/index.css';",
      ),
    );

    const sourcePatches = [
      {
        path: 'src/lib/components/admin/Users/Groups.svelte',
        from: '\n\t/** @type {any[]} */\n\tlet groups = [];',
        to: '\n\tlet groups = [];',
      },
      {
        path: 'src/lib/components/chat/Messages/ContentRenderer.svelte',
        from: '\n\t\t\t/** @type {{ lang?: string; raw?: string; text?: string }} */ token,',
        to: '\n\t\t\ttoken,',
      },
      {
        path: 'src/lib/components/chat/Messages/ContentRenderer.svelte',
        from: 'async (/** @type {string} */ value) =>',
        to: 'async (value) =>',
      },
    ];
    const restored = new Set();
    for (const sourcePatch of sourcePatches) {
      if (!restored.has(sourcePatch.path)) {
        restoreTrackedFile(projectDir, project.commit, sourcePatch.path);
        restored.add(sourcePatch.path);
      }
      const sourcePath = join(projectDir, sourcePatch.path);
      const source = readFileSync(sourcePath, 'utf8');
      if (!source.includes(sourcePatch.from)) {
        throw new Error(`Open WebUI source fixture patch no longer applies: ${sourcePatch.path}`);
      }
      writeFileSync(sourcePath, source.replace(sourcePatch.from, sourcePatch.to));
    }
  } else if (project.id === 'appwrite-console') {
    restoreTrackedFile(projectDir, project.commit, 'vite.config.ts');
    const configPath = join(projectDir, 'vite.config.ts');
    const config = readFileSync(configPath, 'utf8');
    const sentryImport = "import { sentrySvelteKit } from '@sentry/sveltekit';\n";
    const sentryPlugin = `        sentrySvelteKit({\n            adapter: 'auto',\n            sourceMapsUploadOptions: {\n                org: 'appwrite',\n                project: 'console'\n            }\n        }),\n`;
    if (!config.includes(sentryImport) || !config.includes(sentryPlugin)) {
      throw new Error('Appwrite Console Sentry fixture patch no longer applies');
    }
    writeFileSync(configPath, config.replace(sentryImport, '').replace(sentryPlugin, ''));

    restoreTrackedFile(projectDir, project.commit, 'svelte.config.js');
    const svelteConfigPath = join(projectDir, 'svelte.config.js');
    const svelteConfig = readFileSync(svelteConfigPath, 'utf8');
    const precompress = '        precompress: true';
    if (!svelteConfig.includes(precompress)) {
      throw new Error('Appwrite Console precompress fixture patch no longer applies');
    }
    writeFileSync(
      svelteConfigPath,
      svelteConfig.replace(precompress, '        precompress: false'),
    );
  }
  installPhaseProfiler(projectDir);
}

function installPhaseProfiler(projectDir) {
  const profilerPath = join(projectDir, '.rsvelte-benchmark-timings.mjs');
  writeFileSync(
    profilerPath,
    `import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const now = () => performance.timeOrigin + performance.now();

export function rsvelteBenchmarkTimings() {
  const states = new Map();
  const current = (context) => {
    const environment = context.environment?.name ?? 'unknown';
    let state = states.get(environment);
    if (!state) {
      state = { environment };
      states.set(environment, state);
    }
    return state;
  };
  return {
    name: 'rsvelte-benchmark:phase-timings',
    enforce: 'post',
    buildStart() {
      current(this).buildStartAtMs = now();
    },
    buildEnd() {
      current(this).buildEndAtMs = now();
    },
    renderStart() {
      current(this).renderStartAtMs = now();
    },
    generateBundle() {
      current(this).generateBundleAtMs = now();
    },
    writeBundle() {
      current(this).writeBundleAtMs = now();
    },
    closeBundle() {
      const path = process.env.RSVELTE_BENCHMARK_TIMINGS_FILE;
      if (!path) return;
      const state = current(this);
      state.closeBundleAtMs = now();
      const preprocessKey = Symbol.for('rsvelte-benchmark-preprocess');
      const preprocess = globalThis[preprocessKey] ?? [];
      state.preprocess = preprocess.filter(
        (entry) => entry.environment === state.environment
      );
      globalThis[preprocessKey] = preprocess.filter(
        (entry) => entry.environment !== state.environment
      );
      const compileKey = Symbol.for('rsvelte-benchmark-official-compile');
      const compile = globalThis[compileKey] ?? [];
      state.officialCompile = compile.filter(
        (entry) => entry.environment === state.environment
      );
      globalThis[compileKey] = compile.filter(
        (entry) => entry.environment !== state.environment
      );
      appendFileSync(path, JSON.stringify({ kind: 'rolldown-phases', ...state }) + '\\n');
    }
  };
}
`,
  );

  const configPath = join(projectDir, 'vite.config.ts');
  const config = readFileSync(configPath, 'utf8');
  const plugins = 'plugins: [';
  if (!config.includes(plugins)) {
    throw new Error('Vite phase profiler fixture patch no longer applies');
  }
  writeFileSync(
    configPath,
    `import { rsvelteBenchmarkTimings } from './.rsvelte-benchmark-timings.mjs';\n${config.replace(
      plugins,
      'plugins: [rsvelteBenchmarkTimings(),',
    )}`,
  );
}

function installProject(project, projectDir, environment) {
  if (project.packageManager === 'npm') {
    run('npm', ['install', '--no-audit', '--no-fund', '--legacy-peer-deps'], {
      cwd: projectDir,
      env: environment,
      inherit: true,
    });
  } else {
    run('bun', ['install'], {
      cwd: projectDir,
      env: environment,
      inherit: true,
    });
  }
}

function removePreviousSwitches(projectDir) {
  const candidates = [
    join(projectDir, 'node_modules/@sveltejs/vite-plugin-svelte'),
    join(projectDir, 'node_modules/rolldown'),
  ];
  for (const candidate of candidates) {
    try {
      if (lstatSync(candidate).isSymbolicLink()) removeGenerated(projectDir, candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  removeGenerated(projectDir, join(projectDir, '.rsvelte-benchmark-packages'));
}

function copyPackage(source, destination, parent) {
  if (!existsSync(source)) throw new Error(`Installed package not found: ${source}`);
  removeGenerated(parent, destination);
  copyTree(source, destination);
}

function copyTree(source, destination) {
  const status = lstatSync(source);
  if (status.isSymbolicLink()) {
    copyTree(realpathSync(source), destination);
  } else if (status.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source)) {
      copyTree(join(source, entry), join(destination, entry));
    }
  } else if (status.isFile()) {
    copyFileSync(source, destination);
  }
}

function prepareSwitchablePackages(projectDir) {
  const nodeModules = join(projectDir, 'node_modules');
  const stash = join(projectDir, '.rsvelte-benchmark-packages');
  removeGenerated(projectDir, stash);
  mkdirSync(stash, { recursive: true });

  const paths = {
    activePlugin: join(nodeModules, '@sveltejs/vite-plugin-svelte'),
    activeRolldown: join(nodeModules, 'rolldown'),
    officialPlugin: join(stash, 'official-vite-plugin-svelte'),
    officialRolldown: join(stash, 'official-rolldown'),
    rsveltePlugin: join(stash, 'rsvelte-vite-plugin-svelte'),
    rsvelteRolldown: join(stash, 'rsvelte-rolldown'),
  };
  copyPackage(paths.activePlugin, paths.officialPlugin, projectDir);
  copyPackage(paths.activeRolldown, paths.officialRolldown, projectDir);
  copyPackage(join(nodeModules, '@rsvelte/vite-plugin-svelte'), paths.rsveltePlugin, projectDir);
  copyPackage(join(nodeModules, '@rsvelte/rolldown'), paths.rsvelteRolldown, projectDir);
  instrumentPreprocess(paths.officialPlugin);
  instrumentPreprocess(paths.rsveltePlugin);
  instrumentCompile(paths.officialPlugin);
  instrumentCompile(paths.rsveltePlugin);
  return paths;
}

function instrumentPreprocess(packageDir) {
  const path = join(packageDir, 'src/plugins/preprocess.js');
  const source = readFileSync(path, 'utf8');
  const requestGuard = `\t\t\t\tif (!svelteRequest) {\n\t\t\t\t\treturn;\n\t\t\t\t}\n`;
  const catchBlock = `\t\t\t\t} catch (e) {\n\t\t\t\t\tthrow toRollupError(e, options);\n\t\t\t\t}\n`;
  if (!source.includes(requestGuard) || !source.includes(catchBlock)) {
    throw new Error(`Svelte preprocess profiler patch no longer applies: ${path}`);
  }
  writeFileSync(
    path,
    source
      .replace(
        requestGuard,
        `${requestGuard}\t\t\t\tconst benchmarkStartedAtMs = process.env.RSVELTE_BENCHMARK_TIMINGS_FILE\n\t\t\t\t\t? performance.timeOrigin + performance.now()\n\t\t\t\t\t: undefined;\n\t\t\t\tconst benchmarkEnvironment = this.environment.name;\n`,
      )
      .replace(
        catchBlock,
        `\t\t\t\t} catch (e) {\n\t\t\t\t\tthrow toRollupError(e, options);\n\t\t\t\t} finally {\n\t\t\t\t\tif (benchmarkStartedAtMs !== undefined) {\n\t\t\t\t\t\tconst key = Symbol.for('rsvelte-benchmark-preprocess');\n\t\t\t\t\t\t(globalThis[key] ??= []).push({\n\t\t\t\t\t\t\tenvironment: benchmarkEnvironment,\n\t\t\t\t\t\t\tstartAtMs: benchmarkStartedAtMs,\n\t\t\t\t\t\t\tendAtMs: performance.timeOrigin + performance.now()\n\t\t\t\t\t\t});\n\t\t\t\t\t}\n\t\t\t\t}\n`,
      ),
  );
}

function instrumentCompile(packageDir) {
  const path = join(packageDir, 'src/plugins/compile.js');
  const source = readFileSync(path, 'utf8');
  const requestGuard = `\t\t\t\tif (!svelteRequest || svelteRequest.raw) {\n\t\t\t\t\treturn;\n\t\t\t\t}\n`;
  const catchBlock = `\t\t\t\t} catch (e) {\n\t\t\t\t\tthrow toRollupError(e, options);\n\t\t\t\t}\n`;
  if (!source.includes(requestGuard) || !source.includes(catchBlock)) {
    throw new Error(`Svelte compiler profiler patch no longer applies: ${path}`);
  }
  writeFileSync(
    path,
    source
      .replace(
        requestGuard,
        `${requestGuard}\t\t\t\tconst benchmarkStartedAtMs = process.env.RSVELTE_BENCHMARK_TIMINGS_FILE\n\t\t\t\t\t? performance.timeOrigin + performance.now()\n\t\t\t\t\t: undefined;\n\t\t\t\tconst benchmarkEnvironment = this.environment.name;\n`,
      )
      .replace(
        catchBlock,
        `\t\t\t\t} catch (e) {\n\t\t\t\t\tthrow toRollupError(e, options);\n\t\t\t\t} finally {\n\t\t\t\t\tif (benchmarkStartedAtMs !== undefined) {\n\t\t\t\t\t\tconst key = Symbol.for('rsvelte-benchmark-official-compile');\n\t\t\t\t\t\t(globalThis[key] ??= []).push({\n\t\t\t\t\t\t\tenvironment: benchmarkEnvironment,\n\t\t\t\t\t\t\tstartAtMs: benchmarkStartedAtMs,\n\t\t\t\t\t\t\tendAtMs: performance.timeOrigin + performance.now()\n\t\t\t\t\t\t});\n\t\t\t\t\t}\n\t\t\t\t}\n`,
      ),
  );
}

function switchPackages(projectDir, paths, caseId) {
  const targets =
    caseId === 'official'
      ? [paths.officialPlugin, paths.officialRolldown]
      : [paths.rsveltePlugin, paths.rsvelteRolldown];
  for (const active of [paths.activePlugin, paths.activeRolldown]) {
    removeGenerated(projectDir, active);
  }
  mkdirSync(dirname(paths.activePlugin), { recursive: true });
  symlinkSync(targets[0], paths.activePlugin, 'dir');
  symlinkSync(targets[1], paths.activeRolldown, 'dir');

  const pluginPackage = readJson(join(realpathSync(paths.activePlugin), 'package.json'));
  const rolldownPackage = readJson(join(realpathSync(paths.activeRolldown), 'package.json'));
  const expected = cases[caseId];
  if (pluginPackage.name !== expected.expectedPluginName) {
    throw new Error(`Expected ${expected.expectedPluginName}, resolved ${pluginPackage.name}`);
  }
  if (rolldownPackage.name !== expected.expectedRolldownName) {
    throw new Error(`Expected ${expected.expectedRolldownName}, resolved ${rolldownPackage.name}`);
  }
  return {
    plugin: { name: pluginPackage.name, version: pluginPackage.version },
    rolldown: { name: rolldownPackage.name, version: rolldownPackage.version },
  };
}

function cleanBuildOutputs(project, projectDir) {
  for (const output of project.outputs) removeGenerated(projectDir, join(projectDir, output));
  removeGenerated(projectDir, join(projectDir, '.svelte-kit/output'));
}

function runBuild(project, projectDir, environment, logPath) {
  cleanBuildOutputs(project, projectDir);
  const timingsPath = logPath.replace(/\.log$/, '.timings.jsonl');
  mkdirSync(dirname(timingsPath), { recursive: true });
  rmSync(timingsPath, { force: true });
  const startedAtMs = Date.now();
  const started = process.hrtime.bigint();
  const executable = project.build[0] === 'node' ? process.execPath : project.build[0];
  const result = spawnSync(executable, project.build.slice(1), {
    cwd: projectDir,
    env: {
      ...process.env,
      ...environment,
      DEBUG: 'vite-plugin-svelte:stats',
      RSVELTE_BENCHMARK_TIMINGS_FILE: timingsPath,
    },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, output);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${project.name} build failed (${result.status})\n${tail(output, 100)}`);
  }
  const endedAtMs = Date.now();
  const timings = existsSync(timingsPath)
    ? readFileSync(timingsPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  return {
    durationMs,
    profile: summarizeBuildProfile(
      timings,
      parsePluginTimings(output),
      startedAtMs,
      endedAtMs,
      durationMs,
    ),
  };
}

function parsePluginTimings(output) {
  const ansiColor = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  const clean = output.replace(ansiColor, '');
  const rows = new Map();
  const pattern = /^\s+- (.+?) \(\d+%, ([\d.]+)(ms|s), (\d+) calls?\)$/gm;
  for (const match of clean.matchAll(pattern)) {
    const [, label, value, unit, calls] = match;
    const row = rows.get(label) ?? { label, durationMs: 0, calls: 0 };
    row.durationMs += Number(value) * (unit === 's' ? 1000 : 1);
    row.calls += Number(calls);
    rows.set(label, row);
  }
  return [...rows.values()].map((row) => ({
    ...row,
    durationMs: round(row.durationMs),
  }));
}

function intervalDuration(intervals) {
  const sorted = intervals
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end >= start)
    .sort((a, b) => a[0] - b[0]);
  let duration = 0;
  let currentStart;
  let currentEnd;
  for (const [start, end] of sorted) {
    if (currentStart === undefined) {
      currentStart = start;
      currentEnd = end;
    } else if (start <= currentEnd) {
      currentEnd = Math.max(currentEnd, end);
    } else {
      duration += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    }
  }
  return currentStart === undefined ? 0 : duration + currentEnd - currentStart;
}

function exclusivePhaseDurations(phaseRows) {
  const definitions = [
    ['scanAndTransformMs', 'buildStartAtMs', 'buildEndAtMs'],
    ['linkMs', 'buildEndAtMs', 'renderStartAtMs'],
    ['generateMs', 'renderStartAtMs', 'generateBundleAtMs'],
    ['writeMs', 'generateBundleAtMs', 'writeBundleAtMs'],
    ['closeHooksMs', 'writeBundleAtMs', 'closeBundleAtMs'],
  ];
  const intervals = phaseRows.flatMap((row) =>
    definitions
      .map(([name, startField, endField]) => ({
        name,
        start: row[startField],
        end: row[endField],
      }))
      .filter(({ start, end }) => Number.isFinite(start) && Number.isFinite(end) && end >= start),
  );
  const points = [...new Set(intervals.flatMap(({ start, end }) => [start, end]))].sort(
    (a, b) => a - b,
  );
  const durations = Object.fromEntries(definitions.map(([name]) => [name, 0]));
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const active = intervals
      .filter((interval) => interval.start <= start && interval.end >= end)
      .sort((a, b) => a.end - a.start - (b.end - b.start));
    if (active[0]) durations[active[0].name] += end - start;
  }
  return durations;
}

function summarizeBuildProfile(rows, pluginTimings, startedAtMs, endedAtMs, durationMs) {
  const phaseRows = rows.filter((row) => row.kind === 'rolldown-phases');
  const phases = exclusivePhaseDurations(phaseRows);
  const rolldownIntervals = phaseRows.flatMap((row) => [
    [row.buildStartAtMs, row.buildEndAtMs],
    [row.buildEndAtMs, row.renderStartAtMs],
    [row.renderStartAtMs, row.generateBundleAtMs],
    [row.generateBundleAtMs, row.writeBundleAtMs],
    [row.writeBundleAtMs, row.closeBundleAtMs],
  ]);
  const rolldownMeasuredMs = intervalDuration(rolldownIntervals);
  const exclusiveTotalMs = Object.values(phases).reduce((sum, value) => sum + value, 0);
  if (Math.abs(exclusiveTotalMs - rolldownMeasuredMs) > 0.1) {
    throw new Error(
      `Exclusive phase accounting differs from measured Rolldown time: ${exclusiveTotalMs} vs ${rolldownMeasuredMs}`,
    );
  }
  const compileRows = rows.filter((row) => row.kind === 'rsvelte-compile' && row.files > 0);
  return {
    startedAtMs,
    endedAtMs,
    environments: phaseRows.map((row) => row.environment),
    phases: Object.fromEntries(Object.entries(phases).map(([name, value]) => [name, round(value)])),
    rolldownMeasuredMs: round(rolldownMeasuredMs),
    outsideMeasuredRolldownMs: round(Math.max(0, durationMs - rolldownMeasuredMs)),
    preprocessMs: round(
      intervalDuration(
        phaseRows.flatMap((row) =>
          (row.preprocess ?? []).map((entry) => [entry.startAtMs, entry.endAtMs]),
        ),
      ),
    ),
    officialSvelteCompileMs: round(
      intervalDuration(
        phaseRows.flatMap((row) =>
          (row.officialCompile ?? []).map((entry) => [entry.startAtMs, entry.endAtMs]),
        ),
      ),
    ),
    pluginTimings,
    rsvelteCompile: compileRows.map((row) => ({
      generate: row.generate,
      files: row.files,
      errors: row.errors,
      sumMs: round(row.sumMs),
      wallMs: round(row.wallMs),
      directAstFiles: row.directAstFiles,
      nativeReparseFiles: row.nativeReparseFiles,
    })),
  };
}

function findFiles(root, predicate) {
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && predicate(path)) files.push(path);
    }
  };
  visit(root);
  return files.sort((a, b) => a.localeCompare(b));
}

function fingerprintOutputs(project, projectDir) {
  const hash = createHash('sha256');
  const canonicalHash = createHash('sha256');
  let files = 0;
  let bytes = 0;
  let canonicalFiles = 0;
  let canonicalBytes = 0;
  for (const output of project.outputs) {
    const outputDir = join(projectDir, output);
    if (!existsSync(outputDir)) throw new Error(`Missing build output: ${outputDir}`);
    for (const path of findFiles(outputDir, () => true)) {
      const contents = readFileSync(path);
      const name = relative(projectDir, path);
      hash.update(`${name}\0${contents.length}\0`);
      hash.update(contents);
      files += 1;
      bytes += contents.length;
      if (!name.endsWith('.gz') && !name.endsWith('.br')) {
        canonicalHash.update(`${name}\0${contents.length}\0`);
        canonicalHash.update(contents);
        canonicalFiles += 1;
        canonicalBytes += contents.length;
      }
    }
  }
  if (files === 0) throw new Error(`No output files found for ${project.name}`);
  return {
    files,
    bytes,
    sha256: hash.digest('hex'),
    canonical: {
      files: canonicalFiles,
      bytes: canonicalBytes,
      sha256: canonicalHash.digest('hex'),
    },
  };
}

function countSvelteFiles(projectDir) {
  const files = run('git', ['ls-files', '*.svelte'], { cwd: projectDir });
  return files ? files.split('\n').length : 0;
}

function trialSchedule(runs, projectIndex) {
  const first = projectIndex % 2 === 0 ? 'official' : 'rsvelte';
  const second = first === 'official' ? 'rsvelte' : 'official';
  const schedule = [];
  for (let index = 0; index < runs; index += 1) {
    schedule.push(index % 2 === 0 ? first : second, index % 2 === 0 ? second : first);
  }
  return schedule;
}

function statistics(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return {
    medianMs: round(median),
    meanMs: round(mean),
    standardDeviationMs: round(Math.sqrt(variance)),
    minMs: round(sorted[0]),
    maxMs: round(sorted.at(-1)),
  };
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function commandVersion(command, args = ['--version']) {
  try {
    return run(command, args).split('\n')[0];
  } catch {
    return null;
  }
}

function machineMetadata() {
  const cpu =
    process.platform === 'darwin'
      ? commandVersion('sysctl', ['-n', 'machdep.cpu.brand_string'])
      : null;
  const memory =
    process.platform === 'darwin' ? Number(commandVersion('sysctl', ['-n', 'hw.memsize'])) : null;
  return {
    platform: process.platform,
    architecture: process.arch,
    os: commandVersion('uname', ['-srv']),
    cpu,
    memoryBytes: Number.isFinite(memory) ? memory : null,
    node: process.version,
    npm: commandVersion(join(dirname(process.execPath), 'npm')),
    bun: commandVersion('bun'),
  };
}

function summarizeProject(projectResult) {
  const official = projectResult.cases.official.statistics.medianMs;
  const rsvelte = projectResult.cases.rsvelte.statistics.medianMs;
  projectResult.comparison = {
    medianSpeedup: round(official / rsvelte, 3),
    medianTimeReductionPercent: round((1 - rsvelte / official) * 100, 1),
  };
}

function verifyStableOutputs(caseResult, projectName) {
  const fileCounts = new Set(caseResult.outputs.map((output) => output.canonical.files));
  const byteCounts = new Set(caseResult.outputs.map((output) => output.canonical.bytes));
  const hashes = new Set(caseResult.outputs.map((output) => output.canonical.sha256));
  caseResult.outputFileCountStable = fileCounts.size === 1;
  caseResult.outputByteCountStable = byteCounts.size === 1;
  caseResult.outputHashStable = hashes.size === 1;
  if (!caseResult.outputFileCountStable) {
    throw new Error(`${projectName} produced a different output file count within one case`);
  }
}

function summarizeProfiles(profiles) {
  const phaseNames = ['scanAndTransformMs', 'linkMs', 'generateMs', 'writeMs', 'closeHooksMs'];
  const phases = Object.fromEntries(
    phaseNames.map((name) => [name, statistics(profiles.map((profile) => profile.phases[name]))]),
  );
  const officialSvelteCompile = profiles.map((profile) => profile.officialSvelteCompileMs);
  const rsvelteCompileWall = profiles.map((profile) =>
    profile.rsvelteCompile.reduce((sum, row) => sum + row.wallMs, 0),
  );
  const rsvelteCompileSum = profiles.map((profile) =>
    profile.rsvelteCompile.reduce((sum, row) => sum + row.sumMs, 0),
  );
  return {
    phases,
    outsideMeasuredRolldown: statistics(
      profiles.map((profile) => profile.outsideMeasuredRolldownMs),
    ),
    preprocess: statistics(profiles.map((profile) => profile.preprocessMs)),
    officialSvelteCompile: statistics(officialSvelteCompile),
    rsvelteCompileWall: statistics(rsvelteCompileWall),
    rsvelteCompileThreadSum: statistics(rsvelteCompileSum),
  };
}

function benchmarkProject(project, projectIndex, options, packageSpecs, result) {
  console.log(`\n## ${project.name}`);
  const projectDir = cloneProject(project, options.workDir);
  prepareManifest(project, projectDir, packageSpecs);
  removePreviousSwitches(projectDir);
  const environment = {
    PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
    NODE_OPTIONS: '--max-old-space-size=8192',
    npm_config_engine_strict: 'false',
    CYPRESS_INSTALL_BINARY: '0',
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    PUPPETEER_SKIP_DOWNLOAD: '1',
    SENTRY_AUTH_TOKEN: '',
    RSVELTE_BENCHMARK_REQUIRE_NATIVE: '1',
  };
  installProject(project, projectDir, environment);
  const packagePaths = prepareSwitchablePackages(projectDir);
  const projectResult = {
    id: project.id,
    name: project.name,
    repository: project.repository.replace(/\.git$/, ''),
    commit: project.commit,
    svelteFiles: countSvelteFiles(projectDir),
    buildCommand: project.build.join(' '),
    cases: {
      official: { packageResolution: null, durationsMs: [], outputs: [], profiles: [] },
      rsvelte: { packageResolution: null, durationsMs: [], outputs: [], profiles: [] },
    },
  };
  result.projects.push(projectResult);

  const warmupOrder = projectIndex % 2 === 0 ? ['official', 'rsvelte'] : ['rsvelte', 'official'];
  for (let warmup = 0; warmup < options.warmups; warmup += 1) {
    for (const caseId of warmupOrder) {
      const resolution = switchPackages(projectDir, packagePaths, caseId);
      projectResult.cases[caseId].packageResolution = resolution;
      console.log(`warm-up ${warmup + 1}/${options.warmups}: ${cases[caseId].label}`);
      runBuild(
        project,
        projectDir,
        environment,
        join(options.workDir, 'logs', `${project.id}-${caseId}-warmup-${warmup + 1}.log`),
      );
    }
  }

  const caseCounts = { official: 0, rsvelte: 0 };
  for (const caseId of trialSchedule(options.runs, projectIndex)) {
    caseCounts[caseId] += 1;
    const resolution = switchPackages(projectDir, packagePaths, caseId);
    projectResult.cases[caseId].packageResolution = resolution;
    const logPath = join(
      options.workDir,
      'logs',
      `${project.id}-${caseId}-${caseCounts[caseId]}.log`,
    );
    const build = runBuild(project, projectDir, environment, logPath);
    const output = fingerprintOutputs(project, projectDir);
    projectResult.cases[caseId].durationsMs.push(round(build.durationMs));
    projectResult.cases[caseId].outputs.push(output);
    projectResult.cases[caseId].profiles.push(build.profile);
    console.log(
      `${caseCounts[caseId]}/${options.runs} ${cases[caseId].label}: ${(build.durationMs / 1000).toFixed(3)} s`,
    );
    writeJson(options.output, result);
  }

  for (const caseId of Object.keys(cases)) {
    const caseResult = projectResult.cases[caseId];
    caseResult.statistics = statistics(caseResult.durationsMs);
    caseResult.profileStatistics = summarizeProfiles(caseResult.profiles);
    verifyStableOutputs(caseResult, project.name);
  }
  projectResult.outputsEqualAcrossCases =
    projectResult.cases.official.outputs[0].canonical.sha256 ===
    projectResult.cases.rsvelte.outputs[0].canonical.sha256;
  summarizeProject(projectResult);
  writeJson(options.output, result);

  if (!options.keepDependencies) {
    removeGenerated(projectDir, join(projectDir, 'node_modules'));
    removeGenerated(projectDir, join(projectDir, '.rsvelte-benchmark-packages'));
    cleanBuildOutputs(project, projectDir);
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  mkdirSync(options.workDir, { recursive: true });

  const packageSpecs = {
    rolldown: options.rsvelteRolldownDir
      ? stageLocalRolldown(options.rsvelteRolldownDir, options.workDir)
      : options.rsvelteRolldown,
    plugin: options.rsveltePluginDir
      ? stageLocalPlugin(options.rsveltePluginDir, options.workDir)
      : preparePinnedPlugin(options.workDir),
  };
  const selectedProjects = options.projectIds.map((id) =>
    projects.find((project) => project.id === id),
  );
  const result = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    methodology: {
      runsPerCase: options.runs,
      warmupsPerCase: options.warmups,
      measuredUnit:
        'production build wall-clock time, excluding Appwrite adapter-static precompression',
      trialOrder: 'alternating; the first case is reversed between projects',
      installTimeIncluded: false,
      outputCleanup: ['build', '.svelte-kit/output'],
      openWebUiPyodideFetchIncluded: false,
      nativePathGuard:
        'the rsvelte case aborts if either the client or server build reaches the JavaScript Svelte compiler fallback',
      phaseProfiling:
        'benchmark-only Vite hooks partition nested Rolldown builds into exclusive scan/transform, link, generate, write, close-hook, and outside-Rolldown wall time',
      compilerProfiling:
        'official compiler calls are recorded as merged wall-clock intervals; native rsvelte records union wall time and summed worker time inside the Rust builtin',
      preprocessProfiling:
        'vite-plugin-svelte preprocess calls are recorded as wall-clock intervals and merged to avoid double-counting overlap',
      fixtureChanges: {
        'open-webui': [
          'remove warning-only onwarn callback so the native compiler path is eligible',
          'disable sourcemaps consistently because Svelte 5.56.8 emits invalid preserved-comment output',
          'set compilerOptions.preserveComments=false for the same upstream compiler limitation',
          'upgrade vite-plugin-static-copy to 4.1.1',
          'install the @internationalized/date peer required by the resolved bits-ui version',
          'resolve the Tailwind CSS entry explicitly for Vite 8',
          'remove three JSDoc annotations that Svelte 5.56.8 emits as Rolldown-incompatible SSR syntax',
        ],
        'appwrite-console': [
          'disable the Sentry build plugin so random debug IDs do not invalidate output hashes',
          'disable adapter-static precompression so the benchmark measures Vite and Rolldown rather than post-build gzip/Brotli generation',
        ],
      },
    },
    versions,
    packageSpecs,
    machine: machineMetadata(),
    projects: [],
  };
  writeJson(options.output, result);

  for (const [index, project] of selectedProjects.entries()) {
    benchmarkProject(project, index, options, packageSpecs, result);
  }

  console.log(`\nResults: ${options.output}`);
  for (const project of result.projects) {
    const official = project.cases.official.statistics.medianMs / 1000;
    const rsvelte = project.cases.rsvelte.statistics.medianMs / 1000;
    console.log(
      `${project.name}: ${official.toFixed(3)} s -> ${rsvelte.toFixed(3)} s ` +
        `(${project.comparison.medianSpeedup.toFixed(2)}x, ` +
        `${project.comparison.medianTimeReductionPercent.toFixed(1)}%)`,
    );
  }
}

main();
