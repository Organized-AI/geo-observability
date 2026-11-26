-- Usage by person: traces sent by coding tools carry the person in user_id.
CREATE INDEX llm_traces_user ON llm_traces(tenant_id, user_id, start_ms) WHERE user_id IS NOT NULL;
