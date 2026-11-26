-- Coding tools (Claude Code, Codex) and a client's own LLM apps both send traces, but "people" means different
-- things in each: an employee using a tool, or an end user of an app. Usage by person counts coding tools only.
ALTER TABLE trace_apps ADD COLUMN kind TEXT NOT NULL DEFAULT 'app';  -- app | coding_tool
