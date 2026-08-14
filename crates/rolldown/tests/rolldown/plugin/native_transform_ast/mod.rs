use std::{borrow::Cow, path::PathBuf, sync::Arc};

use arcstr::ArcStr;
use oxc::span::SourceType;
use rolldown::{Bundler, BundlerOptions, InputItem};
use rolldown_common::{ModuleType, Output};
use rolldown_ecmascript::EcmaCompiler;
use rolldown_plugin::{HookTransformOutput, HookTransformOutputMap, HookUsage, Plugin};

#[derive(Debug)]
struct NativeAstPlugin;

impl Plugin for NativeAstPlugin {
  fn name(&self) -> Cow<'static, str> {
    Cow::Borrowed("native-ast-test")
  }

  async fn transform(
    &self,
    _ctx: rolldown_plugin::SharedTransformPluginContext,
    args: &rolldown_plugin::HookTransformArgs<'_>,
  ) -> rolldown_plugin::HookTransformReturn {
    if !args.id.ends_with("entry.js") {
      return Ok(None);
    }
    let source = ArcStr::from("export const answer = 42;");
    let ast = EcmaCompiler::parse(args.id, source, SourceType::mjs())?;
    Ok(Some(HookTransformOutput {
      code: Some("export const answer = ;".to_string()),
      ast: Some(ast),
      map: HookTransformOutputMap::Null,
      module_type: Some(ModuleType::Js),
      ..HookTransformOutput::default()
    }))
  }

  fn register_hook_usage(&self) -> HookUsage {
    HookUsage::Transform
  }
}

#[tokio::test(flavor = "multi_thread")]
async fn skips_parsing_when_transform_supplies_an_ast() {
  let project_dir = PathBuf::from(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/rolldown/plugin/native_transform_ast"
  ));
  let mut bundler = Bundler::with_plugins(
    BundlerOptions {
      cwd: Some(project_dir),
      input: Some(vec![InputItem {
        name: Some("entry".to_string()),
        import: "./entry.js".to_string(),
      }]),
      ..BundlerOptions::default()
    },
    vec![Arc::new(NativeAstPlugin)],
  )
  .expect("failed to create bundler");

  let output = bundler.generate().await.expect("native AST should bypass invalid generated code");
  let code = output
    .assets
    .iter()
    .find_map(|asset| match asset {
      Output::Chunk(chunk) => Some(chunk.code.as_str()),
      Output::Asset(_) => None,
    })
    .expect("expected a JavaScript chunk");
  assert!(code.contains("answer = 42"));
}
