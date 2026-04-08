export class PipelineConfigError extends Error {
  override readonly name = 'PipelineConfigError';
}

export class PluginInjectError extends Error {
  override readonly name = 'PluginInjectError';
  readonly pluginName: string;

  constructor(pluginName: string, message: string) {
    super(`Plugin "${pluginName}": ${message}`);
    this.pluginName = pluginName;
  }
}
