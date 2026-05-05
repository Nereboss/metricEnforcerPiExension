export type Severity = "warning" | "error";

export interface FileMetrics {
  filePath: string;
  metrics: Record<string, number>;
}

export interface AnalyzerResult {
  analyzer: string;
  files: FileMetrics[];
}

export interface MetricRule {
  warning?: number;
  error?: number;
}

export interface ResolvedThresholds {
  filePath: string;
  metrics: Record<string, MetricRule>;
}

export interface Violation {
  filePath: string;
  metric: string;
  actual: number;
  threshold: number;
  severity: Severity;
}
