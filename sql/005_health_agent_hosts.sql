-- Saude com varios servidores: a ultima amostra e a base de comparacao sao lidas por host.
ALTER TABLE health_agent_samples
  ADD KEY IF NOT EXISTS health_agent_samples_host (project_id, host, received_at);
