-- Personal tracing keys: an ingest key bound to one person. Traces sent with it carry that person, whatever user.id says.
ALTER TABLE api_keys ADD COLUMN person TEXT;
CREATE INDEX api_keys_person ON api_keys(tenant_id, person) WHERE person IS NOT NULL;
