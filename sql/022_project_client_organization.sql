-- Idempotente: acrescenta apenas organizações em falta, preservando nomes configurados.
INSERT IGNORE INTO identity_organizations (project_id, code, name)
SELECT id, 'client', 'Cliente' FROM projects;
INSERT IGNORE INTO identity_organizations (project_id, code, name)
SELECT id, 'deloitte', 'Deloitte' FROM projects;
