-- P09 (correcao): `delivery_events` passa a ser unica por entrega/evento em vez de pipeline/evento.
-- Fornecedores podem reutilizar identificadores de evento entre entregas (ex.: contador de runs
-- reiniciado); com a chave por pipeline, o evento final de uma entrega nova era tratado como
-- duplicado de uma entrega antiga e a reconciliacao nunca concluia.
-- Aditiva e idempotente (cria a nova chave antes de remover a antiga).
ALTER TABLE delivery_events
  ADD UNIQUE KEY IF NOT EXISTS delivery_events_delivery_event (delivery_id, event_id);

ALTER TABLE delivery_events
  DROP INDEX IF EXISTS delivery_events_event;
