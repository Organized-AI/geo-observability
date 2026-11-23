-- Retention: expired traces are found by start time across all of a workspace's apps, and their spans by trace.
CREATE INDEX llm_spans_trace_time ON llm_spans(tenant_id, trace_id, start_ms);
