export interface TokenUsage {
  readonly prompt: number;
  readonly completion: number;
  readonly total: number;
}

/** Null means no provider usage was observed, rather than zero consumption. */
export interface ObservedTokens {
  readonly prompt: number | null;
  readonly completion: number | null;
  readonly total: number | null;
}

export type CallStatus = "not-started" | "unfinished" | "completed" | "failed" | "cancelled" | "rejected" | "unknown";
export interface CallSpan {
  readonly runId: string;
  readonly callId: string;
  readonly parentCallId: string | null;
  readonly kind: "model" | "tool" | "ptc";
  readonly status: CallStatus;
  /** Model requests without recorded purpose remain unspecified. */
  readonly purpose: "agent" | "compaction" | "unspecified" | null;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly startSeq: number | null;
  readonly endSeq: number | null;
  /** From requested/planned/ptc.started to the confirmed terminal event. */
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly executionStartedAt: string | null;
  readonly permission: "allow" | "deny" | null;
  readonly cleanup: "verified" | "unconfirmed" | null;
  readonly observedTokens: TokenUsage | null;
  readonly chargedTokens: number | null;
  readonly chargedTokensSource: "provider-usage" | "fallback-estimate" | "unclassified" | null;
}

export interface ModelMetrics {
  readonly requests: number;
  readonly completed: number;
  readonly failed: number;
  readonly unfinished: number;
  readonly withUsage: number;
  /** Includes failed and unfinished requests with unknown consumption. */
  readonly missingUsage: number;
  readonly completedWithoutUsage: number;
  /** Sums only provider-reported samples; inspect withUsage/missingUsage for coverage. */
  readonly observedTokens: ObservedTokens;
  /** Historical accounting field. Never presented as provider billing. */
  readonly chargedTokens: number | null;
  readonly chargedTokenSamples: number;
  readonly fallbackEstimatedTokens: number | null;
  readonly fallbackEstimatedSamples: number;
  readonly unclassifiedChargedTokens: number | null;
}

export interface RunMetrics {
  readonly runId: string;
  readonly status: "running" | "completed" | "failed" | "cancelled" | "budget-exited";
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly configHash: string;
  readonly model: {
    readonly all: ModelMetrics;
    readonly agent: ModelMetrics;
    readonly compaction: ModelMetrics;
    readonly unspecified: ModelMetrics;
  };
  readonly tools: {
    /** Planned calls plus rejected attempts; unplanned model children are excluded. */
    readonly attempts: number;
    readonly started: number;
    readonly completed: number;
    readonly errors: number;
    readonly rejected: number;
    readonly cancelled: number;
    readonly notStarted: number;
    readonly unfinished: number;
    readonly unknown: number;
    readonly expectedButUnplanned: number;
  };
  readonly permissions: { readonly allow: number; readonly deny: number };
  readonly ptc: {
    readonly attempts: number;
    readonly completed: number;
    readonly failed: number;
    readonly unknown: number;
    readonly unfinished: number;
    readonly cleanupVerified: number;
    readonly cleanupUnconfirmed: number;
    readonly cleanupUnreported: number;
  };
  readonly compaction: { readonly attempts: number; readonly completed: number; readonly failed: number; readonly unfinished: number };
  readonly context: {
    readonly measurements: number;
    readonly latestPromptTokens: number | null;
    readonly peakPromptTokens: number | null;
    readonly contextWindow: number | null;
    readonly prunedToolResults: number;
  };
  readonly budgetExits: number;
}

export interface ObservabilityReport {
  readonly schemaVersion: 1;
  readonly sessionId: string | null;
  readonly throughSeq: number;
  /** Wall-clock event intervals include orchestration and commit overhead, not CPU time. */
  readonly timingBasis: "committed-event-timestamps";
  readonly runs: readonly RunMetrics[];
  readonly calls: readonly CallSpan[];
}

export interface ObservabilityService {
  snapshot(): ObservabilityReport;
  run(runId: string): RunMetrics | null;
  trace(runId?: string): readonly CallSpan[];
}
