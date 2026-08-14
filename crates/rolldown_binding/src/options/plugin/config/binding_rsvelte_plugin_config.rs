use rolldown_plugin_rsvelte::{RsvelteCompilerOptions, RsveltePlugin, RsveltePluginOptions};

#[napi_derive::napi(object, object_to_js = false)]
#[derive(Debug, Default)]
pub struct BindingRsvelteCompilerOptions {
  pub dev: Option<bool>,
  pub hmr: Option<bool>,
  pub preserve_comments: Option<bool>,
  pub preserve_whitespace: Option<bool>,
  pub runes: Option<bool>,
  pub disclose_version: Option<bool>,
  pub custom_element: Option<bool>,
  pub accessors: Option<bool>,
  pub immutable: Option<bool>,
  pub generate: Option<String>,
  pub namespace: Option<String>,
  pub name: Option<String>,
  pub root_dir: Option<String>,
}

#[napi_derive::napi(object, object_to_js = false)]
#[derive(Debug, Default)]
pub struct BindingRsveltePluginConfig {
  pub compiler_options: Option<BindingRsvelteCompilerOptions>,
  pub extensions: Option<Vec<String>>,
  pub emit_css: Option<bool>,
}

impl TryFrom<BindingRsveltePluginConfig> for RsveltePlugin {
  type Error = napi::Error;

  fn try_from(value: BindingRsveltePluginConfig) -> Result<Self, Self::Error> {
    let compiler_options = value.compiler_options.unwrap_or_default();
    let mut native_compiler_options = RsvelteCompilerOptions::default();
    if let Some(generate) = compiler_options.generate.as_deref() {
      native_compiler_options
        .set_generate(generate)
        .map_err(|message| napi::Error::new(napi::Status::InvalidArg, message))?;
    }
    if let Some(namespace) = compiler_options.namespace.as_deref() {
      native_compiler_options
        .set_namespace(namespace)
        .map_err(|message| napi::Error::new(napi::Status::InvalidArg, message))?;
    }

    Ok(RsveltePlugin::new(RsveltePluginOptions {
      compiler_options: RsvelteCompilerOptions {
        dev: compiler_options.dev.unwrap_or_default(),
        hmr: compiler_options.hmr.unwrap_or_default(),
        preserve_comments: compiler_options.preserve_comments.unwrap_or_default(),
        preserve_whitespace: compiler_options.preserve_whitespace.unwrap_or_default(),
        runes: compiler_options.runes,
        disclose_version: compiler_options.disclose_version.unwrap_or(true),
        custom_element: compiler_options.custom_element.unwrap_or_default(),
        accessors: compiler_options.accessors.unwrap_or_default(),
        immutable: compiler_options.immutable.unwrap_or_default(),
        generate: native_compiler_options.generate,
        namespace: native_compiler_options.namespace,
        name: compiler_options.name,
        root_dir: compiler_options.root_dir,
      },
      extensions: value.extensions.unwrap_or_else(|| vec![".svelte".to_string()]),
      emit_css: value.emit_css.unwrap_or_default(),
    }))
  }
}
