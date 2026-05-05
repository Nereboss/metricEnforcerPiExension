import type { AnalyzerResult } from "../types.js";

/**
 * Contract for metric analyzer plugins.
 *
 * @typeParam TConfig - Global extension configuration type used to decide whether
 * a plugin is enabled and how it should run.
 * @typeParam TContext - Runtime context passed to analyzers (for example process
 * execution helpers, logging, or PI event context wrappers).
 */
export interface AnalyzerPlugin<TConfig extends object, TContext extends object> {
  /** Stable plugin identifier used in config and reporting (e.g. "ccsh"). */
  readonly name: string;

  /**
   * Returns whether this analyzer should run for the provided config.
   *
   * @param config - Parsed extension configuration.
   */
  isEnabled(config: TConfig): boolean;

  /**
   * Filters touched files down to files this analyzer can process.
   *
   * @param files - Files changed by the agent in the current run.
   * @param config - Parsed extension configuration.
   * @returns Subset of files that should be analyzed by this plugin.
   */
  selectFiles(files: readonly string[], config: TConfig): string[];

  /**
   * Executes the underlying tool and returns normalized metrics.
   *
   * @param files - Files selected for this analyzer.
   * @param config - Parsed extension configuration.
   * @param ctx - Runtime dependencies/context needed by the analyzer.
   * @returns Normalized analyzer output consumed by the rules evaluator.
   */
  analyze(files: readonly string[], config: TConfig, ctx: TContext): Promise<AnalyzerResult>;
}
