-- The Starter plan now includes all four engines (ChatGPT, Claude, Gemini, Perplexity).
UPDATE tenants SET model_limit = 4 WHERE plan = 'starter' AND model_limit < 4;
