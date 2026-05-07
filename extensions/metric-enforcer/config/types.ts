import type { MetricRule } from "../types.ts";

export type MetricEnforcerLogLevel = "info" | "warning" | "error";

export interface AnalyzerConfig {
  enabled: boolean;
  command?: string;
  args?: string[];
}

export interface ThresholdConfig {
  global: Record<string, MetricRule>;
  filePatterns: Record<string, Record<string, MetricRule>>;
}

export interface MetricEnforcerConfig {
  logLevel: MetricEnforcerLogLevel;
  analyzers: Record<string, AnalyzerConfig>;
  thresholds: ThresholdConfig;
}
