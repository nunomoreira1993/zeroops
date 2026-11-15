import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AgentProfileDefinition,
  FlowDefinition,
  FlowNode,
  Role,
  User,
} from '../../../../contracts/src/index.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { AgentProfilesService } from './agent-profiles.service.js';
import { queueAgentRun } from './agent-auto-runs.js';
import { AgentRunsService } from './agent-runs.service.js';
import { capabilityManifestHash, profileDefinitionHash } from './capability-catalog.js';
import { RepositoryResources } from './repository-resources.js';
import { buildSkillBundle, parseAgentMarkdown } from './skill-bundle.js';
import { SkillsService } from './skills.service.js';

let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
let profiles: AgentProfilesService;
let skills: SkillsService;
const sites = fileURLToPath(
  new URL('../../../../../tests/fixtures/agent-resource-sites/', import.meta.url),
);

beforeAll(async () => {
  fixture = await startTestDatabase();
  const repository = new RepositoryResources(sites);
  profiles = new AgentProfilesService(fixture.db, repository);
  skills = new SkillsService(fixture.db, repository, profiles);
});
afterAll(async () => {
  await fixture?.stop();
});

async function member(projectId: string, role: Role, instanceAdmin = false): Promise<User> {
  const actor: User = {
    id: randomUUID(),
    projectId,
    role,
    instanceAdmin,
    email: `${randomUUID()}@example.test`,
    displayName: `Pessoa ${role}`,
  };
  await fixture.db.query(
    'INSERT INTO users(id,project_id,email,display_name,role,password_hash,instance_admin) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      actor.id,
      projectId,
      actor.email,
      actor.displayName,
      role,
      'unusable-test-hash',
      instanceAdmin,
    ],
  );
  return actor;
}

async function project(siteKey: string | null = null) {
  const id = randomUUID();
  await fixture.db.query('INSERT INTO projects(id,name,site_key) VALUES($1,$2,$3)', [
    id,
    `P04 ${id.slice(0, 8)}`,
    siteKey,
  ]);
  return { id, admin: await member(id, 'admin'), client: await member(id, 'client') };
}

const skillFiles = (name: string, extra: Record<string, string> = {}, body = 'Instruções.') => [
  {
    path: 'SKILL.md',
    content: `---\nname: ${name}\ndescription: Skill ${name} de teste.\n---\n\n${body}\n`,
  },
  ...Object.entries(extra).map(([path, content]) => ({ path, content })),
];

const upload = (name: string, extra: Record<string, string> = {}, body?: string) => ({
  source: 'upload' as const,
  files: skillFiles(name, extra, body),
});

const definition = (
  name: string,
  allowedTools: AgentProfileDefinition['allowedTools'] = ['log'],
): AgentProfileDefinition => ({
  name,
  description: 'Perfil de teste P04',
  mission: 'Investigar apenas o comportamento explicitamente pedido.',
  expectedInputs: ['Pedido do ticket'],
  expectedOutput: 'Conclusão com evidência e lacunas.',
  completionCriteria: ['Distinguir factos de hipóteses.'],
  modes: ['analysis'],
  allowedTools,
  model: null,
  fusionTier: null,
  reasoningEffort: null,
});

function flowWith(config: Record<string, unknown>): FlowDefinition {
  const node: FlowNode = {
    id: 'investigar',
    op: 'copilot_task',
    label: 'Investigar',
    config: { mode: 'analysis', ...config },
  };
  return {
    schemaVersion: 2,
    start: 'investigar',
    nodes: [node, { id: 'fim', op: 'end', label: 'Fim', config: { outcome: 'resolved' } }],
    edges: [{ id: 'e1', source: 'investigar', port: 'success', target: 'fim' }],
    layout: {},
  } as FlowDefinition;
}

describe('bundle de skill', () => {
  it('valida a estrutura e calcula um hash estável, independente da ordem dos ficheiros', () => {
    const files = skillFiles(
      'diagnose',
      { 'references/guia.md': '# Guia' },
      'Ver [guia](references/guia.md).',
    );
    const first = buildSkillBundle(files);
    const second = buildSkillBundle([...files].reverse());
    expect(first.bundleHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.bundleHash).toBe(first.bundleHash);
    expect(first.manifest.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'references/guia.md',
    ]);
    const changed = buildSkillBundle(skillFiles('diagnose', { 'references/guia.md': '# Guia 2' }));
    expect(changed.bundleHash).not.toBe(first.bundleHash);
  });

  it.each([
    ['sem SKILL.md', [{ path: 'README.md', content: 'x' }]],
    ['caminho a sair da skill', [...skillFiles('a'), { path: '../fora.md', content: 'x' }]],
    ['caminho absoluto', [...skillFiles('a'), { path: '/etc/passwd', content: 'x' }]],
    ['ficheiro oculto', [...skillFiles('a'), { path: '.env', content: 'x' }]],
    ['binário', [...skillFiles('a'), { path: 'bin.txt', content: 'a\u0000b' }]],
    ['link relativo em falta', skillFiles('a', {}, 'Ver [x](references/falta.md).')],
    ['link a sair da skill', skillFiles('a', {}, 'Ver [x](../outra/SKILL.md).')],
    [
      'allowed-tools (auto-aprovação)',
      [
        {
          path: 'SKILL.md',
          content: '---\nname: a\ndescription: d\nallowed-tools: bash\n---\nCorpo\n',
        },
      ],
    ],
    ...[
      'allowed-tools : bash',
      '"allowed-tools": bash',
      "'allowed-tools': [bash]",
      '{allowed-tools: bash}',
      '"allowed\\x2dtools": bash',
    ].map((line): [string, { path: string; content: string }[]] => [
      `allowed-tools disfarçado (${line})`,
      [{ path: 'SKILL.md', content: `---\nname: a\ndescription: d\n${line}\n---\nCorpo\n` }],
    ]),
    [
      'nome inválido',
      [{ path: 'SKILL.md', content: '---\nname: Nome Mau\ndescription: d\n---\nCorpo\n' }],
    ],
    [
      'manifesto inválido',
      skillFiles('a', { 'zeroops-skill.json': '{"requires":{"tools":["rm"]}}' }),
    ],
    [
      'dependência de si própria',
      skillFiles('a', { 'zeroops-skill.json': '{"requires":{"skills":["a"]}}' }),
    ],
  ])('rejeita %s', (_label, files) => {
    expect(() => buildSkillBundle(files)).toThrow(
      expect.objectContaining({ code: 'SKILL_INVALID' }),
    );
  });

  it('importa .agent.md sem conceder ferramentas fora do catálogo nem adotar o modelo de origem', () => {
    const parsed = parseAgentMarkdown(
      '---\nname: Especialista\ndescription: Analisa registos de aplicação com evidência.\ntools: [log, shell, fetch]\nmodel: gpt-x\n---\n\nInstruções do especialista.',
      'Especialista.agent.md',
    );
    expect(parsed.definition).toMatchObject({
      name: 'Especialista',
      allowedTools: ['log'],
      model: null,
    });
    expect(parsed.ignored).toMatchObject({ tools: ['shell', 'fetch'], model: 'gpt-x' });
  });
});

describe('SkillsService', () => {
  it('importa do repositório com recursos relativos e proveniência; versões são imutáveis', async () => {
    const p = await project('pizzahut');
    const imported = await skills.importSkill(p.admin, p.id, {
      source: 'repository',
      path: '.github/skills/diagnose/SKILL.md',
    });
    const v1 = imported.versions[0]!;
    expect(imported).toMatchObject({ name: 'diagnose', currentVersion: 1, boundTools: [] });
    expect(v1.manifest.files.map((file) => file.path)).toEqual(['SKILL.md', 'references/howto.md']);
    expect(v1.source).toMatchObject({
      kind: 'repository',
      path: '.github/skills/diagnose/SKILL.md',
    });

    // Reenviar o mesmo conteúdo não cria versão; conteúdo novo cria v2 sem tocar em v1.
    const same = await skills.addVersion(p.admin, p.id, imported.id, {
      expectedVersion: 1,
      import: { source: 'repository', path: '.github/skills/diagnose/SKILL.md' },
    });
    expect(same.currentVersion).toBe(1);
    const next = await skills.addVersion(p.admin, p.id, imported.id, {
      expectedVersion: 1,
      import: upload('diagnose', {}, 'Instruções revistas.'),
    });
    expect(next.currentVersion).toBe(2);
    expect(next.versions.find((item) => item.version === 1)?.bundleHash).toBe(v1.bundleHash);
    await expect(
      skills.addVersion(p.admin, p.id, imported.id, {
        expectedVersion: 1,
        import: upload('diagnose', {}, 'Conflito.'),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      skills.addVersion(p.admin, p.id, imported.id, {
        expectedVersion: 2,
        import: upload('outro-nome'),
      }),
    ).rejects.toMatchObject({ code: 'SKILL_NAME_MISMATCH' });
    await expect(
      skills.importSkill(p.admin, p.id, { source: 'repository', path: '../../etc/SKILL.md' }),
    ).rejects.toMatchObject({ status: expect.any(Number) });
  });

  it('aplica permissões e isolamento entre projetos', async () => {
    const p = await project();
    const other = await project();
    await expect(skills.importSkill(p.client, p.id, upload('privada'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const skill = await skills.importSkill(p.admin, p.id, upload('privada'));
    await expect(skills.catalog(other.admin, p.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      skills.setBindings(other.admin, other.id, skill.id, { tools: ['log'] }),
    ).rejects.toMatchObject({ status: 404 });
    // Uma etapa de outro projeto não consegue referenciar a skill.
    const profile = await profiles.create(other.admin, other.id, definition('Outro'));
    await expect(
      fixture.db.transaction((client) =>
        profiles.validateFlowDefinition(
          client,
          other.id,
          flowWith({
            agentProfileId: profile.id,
            agentProfileVersion: 1,
            skills: [{ skillId: skill.id, version: 1 }],
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'SKILL_REFERENCE_INVALID' });
  });

  it('partilha só o conteúdo: sem bindings, sem acesso ao destino e revogável', async () => {
    const source = await project();
    const target = await project();
    const skill = await skills.importSkill(source.admin, source.id, upload('partilhada'));
    await skills.setBindings(source.admin, source.id, skill.id, { tools: ['log'] });
    // Um admin da origem sem acesso ao destino não consegue partilhar com ele.
    await expect(
      skills.share(source.admin, source.id, {
        kind: 'skill',
        capabilityId: skill.id,
        version: 1,
        targetProjectId: target.id,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const operator = await member(source.id, 'admin', true);
    const share = await skills.share(operator, source.id, {
      kind: 'skill',
      capabilityId: skill.id,
      version: 1,
      targetProjectId: target.id,
    });
    const incoming = await skills.catalog(target.admin, target.id);
    expect(incoming.incoming.map((item) => item.id)).toEqual([share.id]);
    expect(incoming.skills).toEqual([]);
    await expect(skills.adopt(target.client, target.id, share.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const adopted = await skills.adopt(target.admin, target.id, share.id);
    const copy = (await skills.catalog(target.admin, target.id)).skills.find(
      (item) => item.id === adopted.adoptedCapabilityId,
    )!;
    expect(copy).toMatchObject({ name: 'partilhada', boundTools: [], projectId: target.id });
    expect(copy.versions[0]).toMatchObject({
      bundleHash: skill.versions[0]!.bundleHash,
      source: { kind: 'share', projectId: source.id, capabilityId: skill.id, version: 1 },
    });

    const again = await skills.share(operator, source.id, {
      kind: 'skill',
      capabilityId: skill.id,
      version: 1,
      targetProjectId: (await project()).id,
    });
    await skills.revokeShare(operator, source.id, again.id);
    await expect(skills.adopt(operator, again.targetProjectId, again.id)).rejects.toMatchObject({
      code: 'CAPABILITY_SHARE_REVOKED',
    });
  });

  it('partilha e adota agentes como perfis do destino com proveniência', async () => {
    const source = await project();
    const target = await project();
    const operator = await member(source.id, 'admin', true);
    const profile = await profiles.create(
      source.admin,
      source.id,
      definition('Especialista partilhado'),
    );
    const share = await skills.share(operator, source.id, {
      kind: 'agent',
      capabilityId: profile.id,
      version: 1,
      targetProjectId: target.id,
    });
    const adopted = await skills.adopt(target.admin, target.id, share.id);
    const copy = (await profiles.list(target.admin, target.id)).find(
      (item) => item.id === adopted.adoptedCapabilityId,
    )!;
    expect(copy.versions[0]?.definition.name).toBe('Especialista partilhado');
    expect(copy.versions[0]?.source).toMatchObject({ kind: 'share', projectId: source.id });
  });
});

describe('capacidades nas etapas, manifesto e runs fixados', () => {
  async function setup() {
    const p = await project();
    const main = await profiles.create(p.admin, p.id, definition('Principal', ['log', 'sql']));
    const reader = await profiles.create(p.admin, p.id, definition('Leitor', ['log']));
    const skill = await skills.importSkill(
      p.admin,
      p.id,
      upload('registos', { 'zeroops-skill.json': '{"requires":{"tools":["log"]}}' }),
    );
    const config = {
      agentProfileId: main.id,
      agentProfileVersion: 1,
      skills: [{ skillId: skill.id, version: 1 }],
      delegates: [{ profileId: reader.id, version: 1 }],
      delegation: { maxConcurrency: 2 },
    };
    const validate = (flow: FlowDefinition) =>
      fixture.db.transaction((client) => profiles.validateFlowDefinition(client, p.id, flow));
    return { p, main, reader, skill, config, validate };
  }

  it('bloqueia ativação sem binding, com dependência em falta ou elevação por especialista', async () => {
    const { p, main, skill, config, validate } = await setup();
    await expect(validate(flowWith(config))).rejects.toMatchObject({
      code: 'SKILL_TOOL_NOT_BOUND',
    });
    await skills.setBindings(p.admin, p.id, skill.id, { tools: ['log'] });
    const resolution = await validate(flowWith(config));
    expect(resolution.skills).toEqual([
      expect.objectContaining({
        skillId: skill.id,
        version: 1,
        bundleHash: skill.versions[0]!.bundleHash,
      }),
    ]);
    expect(resolution.delegationByNode).toEqual({ investigar: { maxConcurrency: 2, maxDepth: 1 } });

    const dependent = await skills.importSkill(
      p.admin,
      p.id,
      upload('dependente', { 'zeroops-skill.json': '{"requires":{"skills":["inexistente"]}}' }),
    );
    await expect(
      validate(
        flowWith({ ...config, skills: [...config.skills, { skillId: dependent.id, version: 1 }] }),
      ),
    ).rejects.toMatchObject({ code: 'SKILL_DEPENDENCY_MISSING' });

    const wide = await profiles.create(p.admin, p.id, definition('Largo', ['log', 'prom']));
    await expect(
      validate(flowWith({ ...config, delegates: [{ profileId: wide.id, version: 1 }] })),
    ).rejects.toMatchObject({ code: 'DELEGATE_PERMISSION_ESCALATION' });
    await expect(
      validate(flowWith({ ...config, delegates: [{ profileId: main.id, version: 1 }] })),
    ).rejects.toBeDefined();
    await skills.archive(p.admin, p.id, skill.id);
    await expect(validate(flowWith(config))).rejects.toMatchObject({ code: 'SKILL_ARCHIVED' });
  });

  it('perfis sem capacidades mantêm a resolução e o hash anteriores', async () => {
    const { main, validate } = await setup();
    const resolution = await validate(
      flowWith({ agentProfileId: main.id, agentProfileVersion: 1 }),
    );
    expect(resolution).not.toHaveProperty('skills');
    expect(resolution).not.toHaveProperty('delegates');
    expect(resolution.agentProfiles[0]?.definitionHash).toBe(
      profileDefinitionHash(main.versions[0]!.definition),
    );
  });

  it('fixa versões no run e o claim entrega os ficheiros verificáveis; revogações valem para novos runs', async () => {
    const { p, skill, config } = await setup();
    await skills.setBindings(p.admin, p.id, skill.id, { tools: ['log'] });
    const flow = flowWith(config);
    const snapshot = await profiles.snapshotForExecution(fixture.db, p.id, flow);
    expect(snapshot.error).toBeNull();
    const manifest = snapshot.capabilitiesByNode.investigar!;
    expect(manifest.skills.map((item) => [item.name, item.version])).toEqual([['registos', 1]]);
    expect(manifest.delegates.map((item) => item.displayName)).toEqual(['Leitor']);
    expect(manifest.delegates[0]?.connectorTools).toEqual(['log']);
    expect(manifest.delegation).toEqual({ maxConcurrency: 2, maxDepth: 1 });

    // Uma versão nova não altera o manifesto já fixado.
    await skills.addVersion(p.admin, p.id, skill.id, {
      expectedVersion: 1,
      import: upload('registos', { 'zeroops-skill.json': '{"requires":{"tools":["log"]}}' }, 'v2'),
    });

    const technical = await member(p.id, 'technical');
    const ticket = await new TicketsService(fixture.db).create(p.client, {
      title: 'Pedido P04',
      description: 'Pedido com skill fixada.',
      category: 'question',
      environment: 'production',
      priority: 'medium',
    });
    await fixture.db.query(
      "UPDATE agent_runs SET status='cancelled', lease_until=NULL WHERE status IN ('queued','running')",
    );
    await fixture.db.query(
      "INSERT INTO integration_settings(id,project_id,environment,kind,version,state,values_ciphertext,public_values,secret_configured,updated_by) VALUES($1,$2,'quality','copilot',1,'verified','test-cipher','{}',1,$3)",
      [randomUUID(), p.id, technical.id],
    );
    const runId = await fixture.db.transaction((tx) =>
      queueAgentRun(tx, {
        ticketId: ticket.id,
        projectId: p.id,
        requestedBy: technical.id,
        instructions: 'Analisar.',
        trigger: 'flow',
        ticketVersion: ticket.version,
        allowedTools: ['log', 'sql'],
        capabilityManifest: manifest,
      }),
    );
    const row = await fixture.db.query<{ capability_manifest_hash: string }>(
      'SELECT capability_manifest_hash FROM agent_runs WHERE id=$1',
      [runId],
    );
    expect(row.rows[0]?.capability_manifest_hash).toBe(capabilityManifestHash(manifest));
    const runs = new AgentRunsService(fixture.db);
    const context = await runs.claimNext({ workerId: 'p04-test', leaseSeconds: 60 });
    expect(context?.runId).toBe(runId);
    const files = context!.capabilities!.files[manifest.skills[0]!.versionId]!;
    expect(files.map((file) => file.path)).toEqual(['SKILL.md', 'zeroops-skill.json']);
    expect(files.every((file) => file.sha256.length === 64)).toBe(true);
    expect(context!.capabilities!.manifest.skills[0]?.version).toBe(1);

    // Revogar o binding bloqueia novos runs (snapshot) sem alterar o run já fixado.
    await skills.setBindings(p.admin, p.id, skill.id, { tools: [] });
    const blocked = await profiles.snapshotForExecution(fixture.db, p.id, flow);
    expect(blocked.error).toMatchObject({ code: 'skill_tool_not_bound' });
    const listed = (await runs.list(technical, ticket.id)).find((run) => run.id === runId);
    expect(listed?.capabilities).toMatchObject({
      manifestHash: capabilityManifestHash(manifest),
      skills: [{ name: 'registos', version: 1 }],
      specialists: [{ displayName: 'Leitor', version: 1 }],
      maxConcurrency: 2,
    });
  });
});
