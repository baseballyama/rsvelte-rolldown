use std::{path::PathBuf, sync::Arc};

use rolldown::{Bundler, BundlerOptions, InputItem};
use rolldown_common::Output;
use rolldown_plugin_rsvelte::{RsvelteCompilerOptions, RsveltePlugin, RsveltePluginOptions};

async fn bundle(input: &str, plugin: RsveltePlugin) -> String {
  let project_dir =
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/rolldown/plugin/rsvelte"));
  let mut bundler = Bundler::with_plugins(
    BundlerOptions {
      cwd: Some(project_dir),
      input: Some(vec![InputItem { name: None, import: input.to_string() }]),
      external: Some(
        vec!["svelte/internal/client".to_string(), "svelte/internal/disclose-version".to_string()]
          .into(),
      ),
      ..BundlerOptions::default()
    },
    vec![Arc::new(plugin)],
  )
  .expect("failed to create bundler");

  let output = bundler.generate().await.expect("Svelte component should bundle");
  output
    .assets
    .into_iter()
    .find_map(|asset| match asset {
      Output::Chunk(chunk) => Some(chunk.code.clone()),
      Output::Asset(_) => None,
    })
    .expect("expected a JavaScript chunk")
}

#[tokio::test(flavor = "multi_thread")]
async fn bundles_a_svelte_component_with_the_native_plugin() {
  let code = bundle("./App.svelte", RsveltePlugin::default()).await;
  assert!(code.contains("Hello native Svelte"));
}

#[tokio::test(flavor = "multi_thread")]
async fn falls_back_to_generated_text_for_comments() {
  let code = bundle(
    "./Comment.svelte",
    RsveltePlugin::new(RsveltePluginOptions {
      compiler_options: RsvelteCompilerOptions {
        preserve_comments: true,
        ..RsvelteCompilerOptions::default()
      },
      ..RsveltePluginOptions::default()
    }),
  )
  .await;
  assert!(code.contains("keep this comment"));
  assert!(code.contains("text fallback"));
}
