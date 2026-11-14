import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { Database } from '../../../packages/backend/src/database/database.js';
import { ProjectTicketPurge } from '../../../packages/backend/src/modules/tickets/project-ticket-purge.js';
import {
  ticketPurgeProtocol,
  ticketPurgeRuntimeFingerprint,
} from '../../../packages/backend/src/modules/tickets/ticket-purge-readiness.js';

const { values } = parseArgs({
  options: {
    'project-id': { type: 'string' },
    'project-name': { type: 'string' },
    'database-name': { type: 'string' },
    'database-host': { type: 'string' },
    'actor-id': { type: 'string' },
    expect: { type: 'string' },
    confirm: { type: 'string' },
    apply: { type: 'boolean', default: false },
    readiness: { type: 'string' },
    'runtime-fingerprint': { type: 'boolean', default: false },
    quiesce: { type: 'boolean', default: false },
    resume: { type: 'boolean', default: false },
    'lease-id': { type: 'string' },
  },
});
const required = (key: keyof typeof values) => {
  const value = values[key];
  if (typeof value !== 'string' || !value) throw new Error(`--${key} required.`);
  return value;
};
if (
  [values.apply, values.quiesce, values.resume, values['runtime-fingerprint']].filter(Boolean)
    .length > 1
)
  throw new Error('Select one mode: dry-run, quiesce, resume, apply, runtime-fingerprint.');
if (values['runtime-fingerprint']) {
  if (values.apply) throw new Error('Runtime fingerprint mode cannot apply.');
  console.info(
    JSON.stringify(
      {
        runtimeProtocol: ticketPurgeProtocol,
        runtimeFingerprint: await ticketPurgeRuntimeFingerprint(),
      },
      null,
      2,
    ),
  );
} else {
  const url = process.env.ZEROOPS_DATABASE_URL;
  if (!url) throw new Error('ZEROOPS_DATABASE_URL required (never pass credentials as arguments).');
  const target = {
    projectId: required('project-id'),
    projectName: required('project-name'),
    databaseName: required('database-name'),
    databaseHost: required('database-host'),
    actorId: required('actor-id'),
  };
  const db = new Database(url);
  try {
    const service = new ProjectTicketPurge(db);
    const report = values.apply
      ? await service.apply(
          target,
          required('expect'),
          required('confirm'),
          JSON.parse(await readFile(required('readiness'), 'utf8')),
        )
      : values.quiesce
        ? await service.quiesce(target)
        : values.resume
          ? await service.resume(target, required('lease-id'))
          : await service.dryRun(target);
    console.info(JSON.stringify(report, null, 2));
  } finally {
    await db.close();
  }
}
