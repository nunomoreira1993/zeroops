-- P01 follow-up: identify encrypted GitHub CLI credentials without exposing their secret.
ALTER TABLE project_git_repositories
  ADD COLUMN IF NOT EXISTS credential_provider VARCHAR(20) CHARACTER SET ascii NOT NULL DEFAULT 'token',
  ADD COLUMN IF NOT EXISTS credential_identity VARCHAR(255) NULL;
