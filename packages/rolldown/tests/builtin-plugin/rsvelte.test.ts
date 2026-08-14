import { rolldown } from 'rolldown';
import { expect, test } from 'vitest';

test('compiles Svelte components without plugin configuration', async () => {
  const bundle = await rolldown({
    cwd: import.meta.dirname,
    input: './fixtures/rsvelte/App.svelte',
    external: [/^svelte\/internal\//],
  });

  const { output } = await bundle.generate({ format: 'esm' });
  await bundle.close();

  const chunk = output.find((item) => item.type === 'chunk');
  expect(chunk?.code).toContain('Hello automatic rsvelte');
});

test('replaces the vite-plugin-svelte marker with the configured native compiler', async () => {
  const marker = {
    name: 'vite-plugin-svelte:native-compile',
    __rsvelteNativeOptions: {
      enabled: true,
      compilerOptions: {
        preserveComments: true,
      },
    },
    transform() {
      throw new Error('native marker was not replaced');
    },
  };
  const bundle = await rolldown({
    cwd: import.meta.dirname,
    input: './fixtures/rsvelte/App.svelte',
    external: [/^svelte\/internal\//],
    plugins: [marker],
  });

  const { output } = await bundle.generate({ format: 'esm' });
  await bundle.close();

  const chunk = output.find((item) => item.type === 'chunk');
  expect(chunk?.code).toContain('configured comment');
});

test('leaves a disabled vite-plugin-svelte marker on its fallback path', async () => {
  const marker = {
    name: 'vite-plugin-svelte:native-compile',
    __rsvelteNativeOptions: {
      enabled: false,
    },
    transform(code: string, id: string) {
      if (!id.endsWith('.svelte')) return;
      expect(code).toContain("const message = 'Hello automatic rsvelte'");
      return {
        code: 'export default "vite fallback";',
        moduleType: 'js' as const,
      };
    },
  };
  const bundle = await rolldown({
    cwd: import.meta.dirname,
    input: './fixtures/rsvelte/App.svelte',
    plugins: [marker],
  });

  const { output } = await bundle.generate({ format: 'esm' });
  await bundle.close();

  const chunk = output.find((item) => item.type === 'chunk');
  expect(chunk?.code).toContain('vite fallback');
});
