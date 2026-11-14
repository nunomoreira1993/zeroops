import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { Database } from '../../../packages/backend/src/database/database.js';
import { IdentityService } from '../../../packages/backend/src/modules/identity/identity.service.js';

if (!process.stdin.isTTY)
  throw new Error('Execute num terminal interativo privado. Nao forneca passwords por argumentos.');
if (!process.env.ZEROOPS_DATABASE_URL) throw new Error('ZEROOPS_DATABASE_URL obrigatorio.');
const terminal = createInterface({ input: process.stdin, output: process.stdout });
const email = await terminal.question('Email do administrador: ');
const displayName = await terminal.question('Nome apresentado: ');
terminal.close();
process.stdout.write('Password (nao sera apresentada): ');
const hidden = new Writable({
  write(_chunk, _encoding, done) {
    done();
  },
});
const privateInput = createInterface({ input: process.stdin, output: hidden, terminal: true });
let password: string;
try {
  password = await privateInput.question('');
} finally {
  privateInput.close();
  process.stdout.write('\n');
}
const db = new Database(process.env.ZEROOPS_DATABASE_URL);
try {
  await new IdentityService(db).createInitialAdmin({ email, displayName, password });
  console.info('Administrador criado. A plataforma nao tem utilizadores predefinidos.');
} finally {
  await db.close();
}
