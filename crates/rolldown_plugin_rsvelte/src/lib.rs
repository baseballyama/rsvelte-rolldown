// See internal-docs/rsvelte-native-integration/implementation.md.
use std::{
  borrow::Cow,
  env,
  fmt::Write as _,
  fs::OpenOptions,
  io::Write as _,
  path::PathBuf,
  sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
  },
  time::{Duration, Instant},
};

use anyhow::Context as _;
use arcstr::ArcStr;
use oxc::{
  ast::{
    ast::{ImportOrExportKind, Statement, Str, StringLiteral},
    builder::AstBuilder,
  },
  ast_visit::{Visit, walk},
  span::{SPAN, Span},
};
use oxc_allocator::Allocator;
use rolldown_common::{LogLocation, LogWithoutPlugin, ModuleType};
use rolldown_ecmascript::EcmaAst;
use rolldown_plugin::{
  HookCloseBundleArgs, HookLoadArgs, HookLoadOutput, HookLoadReturn, HookResolveIdArgs,
  HookResolveIdOutput, HookResolveIdReturn, HookTransformOutput, HookTransformOutputMap, HookUsage,
  Plugin, PluginContext, SharedLoadPluginContext, SharedTransformPluginContext,
};
use rolldown_utils::dashmap::FxDashMap;
use rsvelte_core::compiler::Namespace;
use rsvelte_core::{CompileOptions, CssMode, GenerateMode};

#[derive(Debug, Clone)]
#[expect(clippy::struct_excessive_bools)]
pub struct RsvelteCompilerOptions {
  pub dev: bool,
  pub hmr: bool,
  pub preserve_comments: bool,
  pub preserve_whitespace: bool,
  pub runes: Option<bool>,
  pub disclose_version: bool,
  pub custom_element: bool,
  pub accessors: bool,
  pub immutable: bool,
  pub generate: GenerateMode,
  pub namespace: Namespace,
  pub name: Option<String>,
  pub root_dir: Option<String>,
}

impl Default for RsvelteCompilerOptions {
  fn default() -> Self {
    Self {
      dev: false,
      hmr: false,
      preserve_comments: false,
      preserve_whitespace: false,
      runes: None,
      disclose_version: true,
      custom_element: false,
      accessors: false,
      immutable: false,
      generate: GenerateMode::Client,
      namespace: Namespace::Html,
      name: None,
      root_dir: None,
    }
  }
}

impl RsvelteCompilerOptions {
  pub fn set_generate(&mut self, value: &str) -> Result<(), String> {
    self.generate = match value {
      "client" => GenerateMode::Client,
      "server" => GenerateMode::Server,
      value => return Err(format!("Invalid rsvelte compilerOptions.generate value: {value}")),
    };
    Ok(())
  }

  pub fn set_namespace(&mut self, value: &str) -> Result<(), String> {
    self.namespace = match value {
      "html" => Namespace::Html,
      "svg" => Namespace::Svg,
      "mathml" => Namespace::Mathml,
      value => return Err(format!("Invalid rsvelte compilerOptions.namespace value: {value}")),
    };
    Ok(())
  }
}

#[derive(Debug, Clone)]
pub struct RsveltePluginOptions {
  pub compiler_options: RsvelteCompilerOptions,
  pub extensions: Vec<String>,
  pub emit_css: bool,
}

impl Default for RsveltePluginOptions {
  fn default() -> Self {
    Self {
      compiler_options: RsvelteCompilerOptions::default(),
      extensions: vec![".svelte".to_string()],
      emit_css: false,
    }
  }
}

#[derive(Debug)]
pub struct RsveltePlugin {
  options: RsveltePluginOptions,
  css: FxDashMap<ArcStr, CompiledCss>,
  timings: Option<CompileTimings>,
}

#[derive(Debug)]
struct CompiledCss {
  code: ArcStr,
  map: Option<String>,
}

#[derive(Debug)]
struct CompileTimings {
  path: PathBuf,
  state: Mutex<CompileTimingState>,
  reported: AtomicBool,
}

#[derive(Debug, Default)]
struct CompileTimingState {
  active: usize,
  active_since: Option<Instant>,
  wall: Duration,
  sum: Duration,
  files: usize,
  errors: usize,
  direct_ast: usize,
  native_reparse: usize,
}

struct CompileTimer<'a> {
  timings: &'a CompileTimings,
  started: Instant,
}

impl CompileTimings {
  fn from_environment() -> Option<Self> {
    env::var_os("RSVELTE_BENCHMARK_TIMINGS_FILE").map(|path| Self {
      path: path.into(),
      state: Mutex::new(CompileTimingState::default()),
      reported: AtomicBool::new(false),
    })
  }

  fn start(&self) -> CompileTimer<'_> {
    let started = Instant::now();
    let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if state.active == 0 {
      state.active_since = Some(started);
    }
    state.active += 1;
    CompileTimer { timings: self, started }
  }

  fn report(&self, generate: GenerateMode) -> anyhow::Result<()> {
    if self.reported.swap(true, Ordering::Relaxed) {
      return Ok(());
    }
    let state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let generate = match generate {
      GenerateMode::Client => "client",
      GenerateMode::Server => "server",
      GenerateMode::None => "none",
    };
    let row = serde_json::json!({
      "kind": "rsvelte-compile",
      "generate": generate,
      "files": state.files,
      "errors": state.errors,
      "sumMs": state.sum.as_secs_f64() * 1000.0,
      "wallMs": state.wall.as_secs_f64() * 1000.0,
      "directAstFiles": state.direct_ast,
      "nativeReparseFiles": state.native_reparse,
    });
    let mut file = OpenOptions::new().create(true).append(true).open(&self.path)?;
    writeln!(file, "{row}")?;
    Ok(())
  }
}

impl CompileTimer<'_> {
  fn finish(self, client: bool, direct_ast: bool, failed: bool) {
    let ended = Instant::now();
    let mut state = self.timings.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    state.sum += ended.duration_since(self.started);
    state.files += 1;
    state.errors += usize::from(failed);
    if client {
      if direct_ast {
        state.direct_ast += 1;
      } else {
        state.native_reparse += 1;
      }
    }
    state.active -= 1;
    if state.active == 0 {
      let active_since = state.active_since.take().expect("active timer has start");
      state.wall += ended.duration_since(active_since);
    }
  }
}

#[derive(Default)]
struct SourceDependentSpans(bool);

impl Visit<'_> for SourceDependentSpans {
  fn visit_span(&mut self, span: &Span) {
    self.0 |= *span != SPAN;
    walk::walk_span(self, span);
  }
}

fn has_source_dependent_spans(program: &oxc::ast::ast::Program<'_>) -> bool {
  let mut visitor = SourceDependentSpans::default();
  visitor.visit_program(program);
  visitor.0
}

impl RsveltePlugin {
  pub fn new(options: RsveltePluginOptions) -> Self {
    Self { options, css: FxDashMap::default(), timings: CompileTimings::from_environment() }
  }
}

impl Default for RsveltePlugin {
  fn default() -> Self {
    Self::new(RsveltePluginOptions::default())
  }
}

impl Plugin for RsveltePlugin {
  fn name(&self) -> Cow<'static, str> {
    Cow::Borrowed("builtin:rsvelte")
  }

  async fn resolve_id(
    &self,
    _ctx: &PluginContext,
    args: &HookResolveIdArgs<'_>,
  ) -> HookResolveIdReturn {
    if args.specifier.contains("?svelte&type=style") {
      return Ok(Some(HookResolveIdOutput::from_id(args.specifier)));
    }
    Ok(None)
  }

  async fn load(&self, _ctx: SharedLoadPluginContext, args: &HookLoadArgs<'_>) -> HookLoadReturn {
    let Some(css) = self.css.get(args.id) else {
      return Ok(None);
    };
    let map = css
      .map
      .as_deref()
      .map(rolldown_sourcemap::OwnedSourceMap::from_json_string)
      .transpose()?
      .map(rolldown_sourcemap::OwnedSourceMap::into_inner);
    Ok(Some(HookLoadOutput {
      code: css.code.clone(),
      map,
      module_type: Some(ModuleType::Css),
      ..HookLoadOutput::default()
    }))
  }

  async fn transform(
    &self,
    ctx: SharedTransformPluginContext,
    args: &rolldown_plugin::HookTransformArgs<'_>,
  ) -> rolldown_plugin::HookTransformReturn {
    if args.id.contains("?svelte&type=style")
      || args.id.contains("?raw")
      || args.id.contains("&raw")
      || args.id.contains("?url")
      || args.id.contains("&url")
      || args.id.contains("?direct")
      || args.id.contains("&direct")
    {
      return Ok(None);
    }
    let filename = args.id.split('?').next().unwrap_or(args.id);
    if !self.options.extensions.iter().any(|extension| filename.ends_with(extension)) {
      return Ok(None);
    }

    let compiler_options = &self.options.compiler_options;
    let enable_sourcemap = ctx.options().sourcemap.is_some();
    let options = CompileOptions {
      dev: compiler_options.dev,
      generate: compiler_options.generate,
      filename: Some(filename.to_string()),
      root_dir: compiler_options.root_dir.clone(),
      name: compiler_options.name.clone(),
      custom_element: compiler_options.custom_element,
      accessors: compiler_options.accessors,
      namespace: compiler_options.namespace,
      immutable: compiler_options.immutable,
      css: if self.options.emit_css { CssMode::External } else { CssMode::Injected },
      preserve_comments: compiler_options.preserve_comments,
      preserve_whitespace: compiler_options.preserve_whitespace,
      runes: compiler_options.runes,
      disclose_version: compiler_options.disclose_version,
      hmr: compiler_options.hmr,
      enable_sourcemap,
      ..CompileOptions::default()
    };

    let virtual_css_id = (self.options.emit_css
      && compiler_options.generate == GenerateMode::Client)
      .then(|| format!("{filename}?svelte&type=style&lang.css"));
    let mut ast = None;
    let mut sink =
      |program: &rsvelte_core::compiler::phases::phase3_transform::JsProgram,
       arena: &rsvelte_core::compiler::phases::phase3_transform::js_ast::JsArena| {
        ast = EcmaAst::try_from_allocator_and_source(
          ArcStr::clone(args.code),
          Allocator::default(),
          |source, allocator| {
            let mut converted =
              rsvelte_core::compiler::phases::phase3_transform::js_ast::to_oxc::program_to_oxc(
                program, arena, allocator,
              )?;
            // Rolldown plugins may slice transformed code with AST spans, so only a
            // fully synthetic program can bypass the native OXC parse safely.
            if converted.comment_source.is_some() || has_source_dependent_spans(&converted.program)
            {
              return None;
            }
            if let Some(virtual_css_id) = virtual_css_id.as_deref() {
              let builder = AstBuilder::new(allocator);
              converted.program.body.push(Statement::new_import_declaration(
                SPAN,
                None,
                StringLiteral::new(
                  SPAN,
                  Str::from_str_in(virtual_css_id, &builder),
                  None,
                  &builder,
                ),
                None,
                None,
                ImportOrExportKind::Value,
                &builder,
              ));
            }
            converted.program.source_text = source;
            Some(converted.program)
          },
        );
      };

    let timer = self.timings.as_ref().map(CompileTimings::start);
    let result = if compiler_options.generate == GenerateMode::Client {
      rsvelte_core::compiler::compile_client_with_program_sink(args.code, options, &mut sink)
    } else {
      rsvelte_core::compiler::compile(args.code, options)
    };
    if let Some(timer) = timer {
      timer.finish(
        compiler_options.generate == GenerateMode::Client,
        ast.is_some(),
        result.is_err(),
      );
    }
    let mut result = result.with_context(|| format!("Failed to compile {filename}"))?;

    if let Some(virtual_css_id) = virtual_css_id {
      let css = result.css.take();
      self.css.insert(
        virtual_css_id.clone().into(),
        CompiledCss {
          code: css.as_ref().map_or_else(|| ArcStr::from(""), |css| css.code.as_str().into()),
          map: css.and_then(|css| css.map),
        },
      );
      writeln!(result.js.code, "\nimport {virtual_css_id:?};")?;
    }

    for warning in result.warnings {
      let loc = warning.start.as_ref().map(|position| LogLocation {
        line: u32::try_from(position.line).unwrap_or(u32::MAX),
        column: u32::try_from(position.column).unwrap_or(u32::MAX),
        file: Some(filename.to_string()),
      });
      let pos = warning
        .start
        .as_ref()
        .map(|position| u32::try_from(position.character).unwrap_or(u32::MAX));
      ctx.warn(LogWithoutPlugin {
        message: warning.message,
        id: Some(filename.to_string()),
        code: Some(warning.code),
        loc,
        pos,
        ..LogWithoutPlugin::default()
      });
    }

    let map = match result.js.map {
      Some(map) => HookTransformOutputMap::Sourcemap(
        rolldown_sourcemap::OwnedSourceMap::from_json_string(&map)?.into_inner().into(),
      ),
      None => HookTransformOutputMap::Null,
    };

    Ok(Some(HookTransformOutput {
      code: Some(result.js.code),
      ast,
      map,
      module_type: Some(ModuleType::Js),
      ..HookTransformOutput::default()
    }))
  }

  fn register_hook_usage(&self) -> HookUsage {
    let usage = HookUsage::ResolveId | HookUsage::Load | HookUsage::Transform;
    if self.timings.is_some() { usage | HookUsage::CloseBundle } else { usage }
  }

  async fn close_bundle(
    &self,
    _ctx: &PluginContext,
    _args: Option<&HookCloseBundleArgs<'_>>,
  ) -> rolldown_plugin::HookNoopReturn {
    if let Some(timings) = &self.timings {
      timings.report(self.options.compiler_options.generate)?;
    }
    Ok(())
  }
}
