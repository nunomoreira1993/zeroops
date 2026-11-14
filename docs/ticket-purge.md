# Manual project ticket purge

The CLI is dry-run by default. No HTTP/UI deletion endpoint exists. Migration
`031_ticket_purge_state.sql` creates suppression metadata only; destructive work is
never executed by migrations. `sql/manual/purge_project_tickets.sql` is a read-only
preflight and guarded-deletion reference, not a bypass around the service.

## Important live-runtime safety interlock

Apply now has a real live path, but **no database-name exception or force flag**.
Every database, including tests, requires a fresh administrative attestation,
matching runtime fingerprint and an actual project maintenance lease.
At the pre-rollout baseline, QA SHA `f0180507` lacked these runtime guards.
**Live operation remains blocked until the rollout and fresh runtime/process/artifact
evidence are verified.** Exporting CLI/schema does not upgrade running binaries;
a successful deploy alone does not authorize or execute ticket deletion.

The attestation is an administrator's explicit verification, not an automatic
remote probe. Its process/artifact evidence hashes must identify retained,
reviewed reports outside tickets. The CLI validates coverage, exact target,
scope/build digests, restart/deployment ordering, zero unsafe leftovers, lease
ownership/expiry, and a maximum five-minute evidence window; it does not invent
evidence or trust an arbitrary enable flag.

1. Obtain deployment authorization. Apply the additive `031_ticket_purge_state.sql`
   and deploy the reviewed build to **every API, worker and executor instance**.
   Keep Health collection and Health email delivery active. Never pause the whole
   combined Health/flow worker for ticket maintenance.
2. Verify process/container inventory, running image/revision, executable root and
   startup time after rollout. Run `--runtime-fingerprint` **inside each actual
   deployed runtime root**, not in a separately exported CLI directory. All role
   instances must match the reviewed build; confirm no old instances remain.
   Files matching on disk alone do not prove an old process loaded new code.
3. Restrict project ticket mutation endpoints through an authorized scoped ingress
   control (leave Health ingestion/UI and other projects accessible). Establish the
   ten-minute project ticket lease with `--quiesce`. New ticket creation, agent
   queuing/claims, ticket assistant claims, flow progression and ticket delivery
   honor that lease; Health metrics, alerts and email delivery continue.
4. Finish/cancel existing work through supported controls; do not force-kill by
   name. The lease does not cancel active work. Inventory project-specific child
   processes, exclusive workspaces/artifacts and external ticket queues. Reconcile
   or remove only verified exclusive artifacts; never delete shared SDK caches,
   source roots or other projects' files. Unverifiable leftovers block apply.
5. Run a new dry-run under the lease. Review counts/blockers and record its scope
   digest and runtime fingerprint. Complete the attestation below only after the
   above checks, binding the verified administrator/project/DB and actual lease.
6. Apply before proof/lease expiry. Failure rolls back and retains the lease for
   review; explicitly `--resume --lease-id` to abort maintenance. Successful apply
   releases its own lease atomically. Remove the scoped ingress restriction after
   postflight. Leases also expire automatically; repeat verification/dry-run if
   they expire. Do not silently renew or overwrite another live lease.

## Commands (from the ZeroOps root)

Use the existing secure environment for `ZEROOPS_DATABASE_URL`; never put its value
in arguments or reports. Obtain `DATABASE()` and `@@hostname` from the exact target;
`database-host` is the database server's reported hostname, not the SSH host alias.
`actor-id` must identify an enabled administrator of the exact project/instance.

```powershell
node dist\apps\api\src\purge-project-tickets.js --project-id "00000000-0000-4000-8000-000000000001" --project-name "Pizza Hut" --database-name "<verified DATABASE()>" --database-host "<verified @@hostname>" --actor-id "<enabled administrator UUID>"
```

Using the same verified target arguments (`$a`) as the dry-run:

```powershell
node dist\apps\api\src\purge-project-tickets.js --runtime-fingerprint
node dist\apps\api\src\purge-project-tickets.js @a --quiesce
node dist\apps\api\src\purge-project-tickets.js @a
node dist\apps\api\src\purge-project-tickets.js @a --apply --expect "<fresh scope digest>" --readiness ".\verified-ticket-purge.json" --confirm "DELETE ALL TICKETS Pizza Hut 00000000-0000-4000-8000-000000000001"
node dist\apps\api\src\purge-project-tickets.js @a --resume --lease-id "<own lease UUID>"
```

`--runtime-fingerprint` needs no database credentials and makes no changes.
Export `sql/manual/purge_project_tickets.sql` with the compiled CLI: its bound
deletion statements are loaded and compared to the reviewed contract.

## Required attestation

JSON must conform to `ticketPurgeReadinessSchema` in `ticket-purge-readiness.ts`;
unknown fields are rejected. The following is a **non-operational template**:
replace placeholders with verified facts, not guessed values. Include all
instances in each role array. Store no passwords, tokens, private keys or deleted
ticket contents.

```json
{
  "protocol": "zeroops.ticket-purge.v1",
  "target": {
    "projectId": "<verified project UUID>",
    "projectName": "Pizza Hut",
    "databaseName": "<DATABASE()>",
    "databaseHost": "<@@hostname>",
    "actorId": "<verified administrator UUID>"
  },
  "scopeDigest": "<fresh dry-run SHA256>",
  "runtimeFingerprint": "<verified deployed fingerprint>",
  "approvedRevision": "<reviewed 40-character source SHA>",
  "checkedAt": "<UTC ISO timestamp>",
  "validUntil": "<UTC ISO timestamp within five minutes>",
  "deploymentAuthorized": true,
  "processInventoryEvidenceSha256": "<retained verified inventory SHA256>",
  "allRuntimeInstancesCovered": true,
  "legacyRuntimeInstances": 0,
  "runtimes": [
    {
      "role": "api",
      "instances": [
        {
          "instanceId": "<actual host/container/PID identity>",
          "revision": "<same approved revision>",
          "runtimeFingerprint": "<same verified fingerprint>",
          "deployedAt": "<UTC ISO timestamp>",
          "startedAt": "<UTC ISO timestamp after deployment>"
        }
      ]
    },
    { "role": "worker", "instances": ["<same instance object shape; all workers>"] },
    { "role": "executor", "instances": ["<same instance object shape; all executors>"] }
  ],
  "quiescence": {
    "leaseId": "<actual --quiesce result UUID>",
    "heldUntil": "<actual lease expiry covering validUntil>",
    "ticketWritesBlocked": true,
    "ticketExecutorsPaused": true,
    "activeTicketProcesses": 0,
    "healthCollectionContinuing": true,
    "healthEmailDeliveryContinuing": true,
    "evidenceSha256": "<verified guard/process observation SHA256>"
  },
  "artifacts": {
    "inventoryComplete": true,
    "exclusiveTicketArtifactsRemaining": 0,
    "orphanTicketWorkspaces": 0,
    "externalTicketQueueItemsRemaining": 0,
    "evidenceSha256": "<retained scoped artifact inventory/reconciliation SHA256>"
  }
}
```

## Guarantees and limits

- One transaction locks the project and scoped tickets/dependents. Existing
  membership-based creation shares that project lock; queue claims share row locks.
  Active runs, running assistants, pending/running execution/deployment, uncertain
  deployment/delivery, claimed relays and processing deliveries abort before deletion.
  Finish/reconcile them through normal supported controls, then repeat dry-run.
- Actual `information_schema` FK edges are checked each time. Unknown incoming
  dependencies fail closed; constraints remain enabled. Ticket conversations,
  revisions, proposals, approvals, runs/tool calls/inputs/events, ticket assistant
  requests, flow execution history, ticket audit history and outbox deliveries go
  child-first. Shared flows, profiles, integrations, project and numbering survive.
- Action confirmations targeting scoped tickets are removed. Deleting runs removes
  their connector token hashes; late FK-backed callbacks cannot recreate deleted runs.
- All Health alerts/events/metrics/emails survive. Only operational ticket references
  are cleared/replaced. Active internal/external occurrence timestamps are remembered,
  including unlinked alerts. The same occurrence cannot recreate a ticket in the
  updated runtime; recovery/new start naturally stops matching the suppression.
  Health notification payload/body content is intentionally not rewritten.
- Executor workspaces are already ephemeral and removed in its `finally` block;
  patches/reports/conversation data managed here live in database rows. There is
  no durable per-ticket file registry, and this tool never guesses filesystem paths
  or deletes shared SDK caches. Before any future live enablement, inspect executor
  shutdown/orphan workspace evidence and any external artifacts/SDK persistence
  separately; absence of active DB runs alone is not proof of no orphan process.
- A minimal non-ticket audit event retains actor/project/counts/result, never
  deleted conversation content, plus readiness digest/revision/lease identity.
  Errors roll the relational operation back. Proof expiry and local runtime hash
  are rechecked immediately before commit.
