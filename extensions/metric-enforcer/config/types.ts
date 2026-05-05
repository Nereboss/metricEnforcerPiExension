import type { MetricRule } from "../types.js";

export interface AnalyzerConfig {
  enabled: boolean;
  command?: string;
  args?: string[];
  options?: Record<string, string | number | boolean | null>;
}

export interface ThresholdConfig {
  global: Record<string, MetricRule>;
  filePatterns: Record<string, Record<string, MetricRule>>;
}

export interface MetricEnforcerConfig {
  analyzers: Record<string, AnalyzerConfig>;
  thresholds: ThresholdConfig;
}
