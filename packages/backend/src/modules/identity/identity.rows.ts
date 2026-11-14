import type { Role, User } from '../../../../contracts/src/index.js';

export interface UserRow {
  id: string;
  project_id: string;
  email: string;
  display_name: string;
  role: Role;
  password_hash: string;
  disabled: boolean;
  organization: 'client' | 'deloitte' | null;
  locale: 'pt-PT' | 'en';
  password_failures: number;
  locked_until: Date | null;
  mfa_secret: string | null;
  mfa_last_step: string | null;
  instance_admin: boolean;
  mfa_enrollment_required: boolean;
  mfa_opt_out: boolean;
  password_change_required?: boolean;
  avatar_version?: number | null;
}

/** Converte uma linha da BD no contrato público sem expor hashes, MFA ou flags internas. */
export function toUser(row: UserRow): User {
  return {
    id: row.id,
    projectId: row.project_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    organization: row.organization,
    locale: row.locale,
    ...(row.instance_admin ? { instanceAdmin: true } : {}),
    ...(row.password_change_required ? { passwordChangeRequired: true } : {}),
    ...(row.avatar_version ? { avatarVersion: row.avatar_version } : {}),
  };
}
