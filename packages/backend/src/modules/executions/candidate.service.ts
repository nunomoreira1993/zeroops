import { createHash, randomUUID } from 'node:crypto';
import { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { candidateManifestSchema } from './candidate-manifest.js';

/** Regista o manifesto de uma execução apenas se ticket, versão e run continuarem válidos. */
export class CandidateService {
  constructor(private readonly db: Database) {}

  /** Verifica paths/hashes e avança o ticket para QA de forma transacional. */
  async recordVerifiedCandidate(runId: string, rawManifest: unknown) {
    const manifest = candidateManifestSchema.parse(rawManifest);
    const paths = new Set(manifest.files.map((file) => file.path));
    const removed = 'vcs' in manifest ? manifest.removed : [];
    if (
      paths.size !== manifest.files.length ||
      manifest.sqlFiles.some((path) => !paths.has(path)) ||
      removed.some((path) => paths.has(path)) ||
      paths.size + removed.length === 0
    ) {
      throw new DomainError(
        'invalid_manifest',
        'Manifesto com ficheiros duplicados ou SQL sem hash.',
      );
    }
    const hash = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
    return this.db.transaction(async (client) => {
      const result = await client.query<{
        ticket_id: string;
        ticket_version: number;
        status: string;
        version: number;
        ticket_status: string;
      }>(
        `SELECT r.ticket_id,r.ticket_version,r.status,t.version,t.status AS ticket_status
         FROM execution_runs r JOIN tickets t ON t.id=r.ticket_id WHERE r.id=$1 FOR UPDATE`,
        [runId],
      );
      const run = result.rows[0];
      if (
        !run ||
        run.status !== 'running' ||
        run.ticket_status !== 'implementing' ||
        run.ticket_version !== run.version
      ) {
        throw new DomainError('stale_execution', 'Execucao ausente, interrompida ou obsoleta.');
      }
      await client.query(
        "UPDATE execution_runs SET status='completed',candidate_hash=$2,manifest=$3,updated_at=NOW(3) WHERE id=$1",
        [runId, hash, JSON.stringify(manifest)],
      );
      await client.query(
        "UPDATE tickets SET status='awaiting_qa',version=version+1,updated_at=NOW(3) WHERE id=$1",
        [run.ticket_id],
      );
      await client.query(
        "INSERT INTO ticket_events(id,ticket_id,from_status,to_status) VALUES($1,$2,'implementing','awaiting_qa')",
        [randomUUID(), run.ticket_id],
      );
      await client.query(
        "INSERT INTO audit_events(id,ticket_id,action,details) VALUES($1,$2,'candidate.recorded',$3)",
        [randomUUID(), run.ticket_id, JSON.stringify({ runId, hash })],
      );
      return { hash };
    });
  }
}
