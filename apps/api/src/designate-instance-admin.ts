import { createInterface } from 'node:readline/promises';
import { Database } from '../../../packages/backend/src/database/database.js';
import { IdentityService } from '../../../packages/backend/src/modules/identity/identity.service.js';

if (!process.stdin.isTTY) throw new Error('Execute num terminal interativo privado.');
if (!process.env.ZEROOPS_DATABASE_URL) throw new Error('ZEROOPS_DATABASE_URL obrigatorio.');

const terminal = createInterface({ input: process.stdin, output: process.stdout });
const email = await terminal.question('Email do administrador de projeto existente: ');
terminal.close();

const db = new Database(process.env.ZEROOPS_DATABASE_URL);
try {
  await new IdentityService(db).designateInitialInstanceAdmin(email);
  console.info('Administrador da instância designado; será exigida MFA no próximo acesso.');
} finally {
  await db.close();
}
