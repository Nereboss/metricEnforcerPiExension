import type { MetricRule } from "../types.ts";

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
  analyzers: Record<string, AnalyzerConfig>;
  thresholds: ThresholdConfig;
}
