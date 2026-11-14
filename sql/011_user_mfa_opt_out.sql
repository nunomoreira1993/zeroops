-- Permite que cada utilizador desative o MFA da propria conta, mesmo quando o perfil o exige por
-- defeito (equipa/administrador). Volta a 0 quando o MFA e configurado de novo ou reposto por um
-- administrador. Idempotente.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_opt_out TINYINT(1) NOT NULL DEFAULT 0;
