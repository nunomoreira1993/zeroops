import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapabilityRunManifest, RunAgent } from '../../../packages/contracts/src/index.js';
import {
  CapabilityIntegrityError,
  CapabilityToolGuard,
  compileSessionCapabilities,
  materializeCapabilities,
  type RunCapabilities,
} from './capability-bundle.js';
import { CopilotCliAdapter } from './copilot.adapter.js';
import { createRedactor, mapSessionEvent } from './session-event-mapper.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function root() {
  const directory = await mkdtemp(join(tmpdir(), 'zeroops-capabilities-'));
  roots.push(directory);
  return directory;
}

const sha = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');
const agent = (name: string, connectorTools: string[] = []): RunAgent => ({
  name,
  displayName: name,
  description: `Agente ${name}`,
  profileId: '00000000-0000-4000-8000-000000000001',
  version: 1,
  definitionHash: 'a'.repeat(64),
  prompt: `Missão de ${name}`,
  connectorTools,
  model: null,
});

function capabilities(overrides: Partial<CapabilityRunManifest> = {}): RunCapabilities {
  const files = [
    { path: 'SKILL.md', content: '---\nname: registos\ndescription: d\n---\nVer guia.\n' },
    { path: 'references/guia.md', content: '# Guia\n' },
  ].map((file) => ({ ...file, sha256: sha(file.content) }));
  const manifest: CapabilityRunManifest = {
    format: 1,
    agent: agent('principal'),
    skills: [
      {
        skillId: 's1',
        versionId: 'v1',
        version: 1,
        name: 'registos',
        description: 'd',
        bundleHash: 'b'.repeat(64),
        files: files.map(({ path, sha256, content }) => ({ path, sha256, size: content.length })),
        requiredTools: [],
      },
    ],
    delegates: [agent('leitor', ['log'])],
    delegation: { maxConcurrency: 1, maxDepth: 1 },
    ...overrides,
  };
  return { manifest, files: { v1: files } };
}

describe('materialização de skills fixadas', () => {
  it('reproduz a árvore relativa só de leitura e remove-a no fim', async () => {
    const base = await root();
    const { compiled, cleanup } = await materializeCapabilities(base, capabilities());
    const directory = compiled.skillDirectory!;
    expect(await readFile(join(directory, 'registos', 'references', 'guia.md'), 'utf8')).toBe(
      '# Guia\n',
    );
    await expect(
      writeFile(join(directory, 'registos', 'SKILL.md'), 'alterado'),
    ).rejects.toMatchObject({ code: expect.stringMatching(/EACCES|EPERM/) });
    await cleanup();
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('falha fechado com conteúdo adulterado, ficheiros a mais ou caminhos inseguros', async () => {
    const base = await root();
    const tampered = capabilities();
    tampered.files.v1![1] = { ...tampered.files.v1![1]!, content: '# Outro\n' };
    await expect(materializeCapabilities(base, tampered)).rejects.toBeInstanceOf(
      CapabilityIntegrityError,
    );
    const extra = capabilities();
    extra.files.v1!.push({ path: 'extra.md', content: 'x', sha256: sha('x') });
    await expect(materializeCapabilities(base, extra)).rejects.toBeInstanceOf(
      CapabilityIntegrityError,
    );
    const traversal = capabilities();
    const content = 'x';
    traversal.manifest.skills[0]!.files[1] = { path: '../fora.md', sha256: sha(content), size: 1 };
    traversal.files.v1![1] = { path: '../fora.md', content, sha256: sha(content) };
    await expect(materializeCapabilities(base, traversal)).rejects.toBeInstanceOf(
      CapabilityIntegrityError,
    );
    const badName = capabilities();
    badName.manifest.skills[0]!.name = '../x';
    await expect(materializeCapabilities(base, badName)).rejects.toBeInstanceOf(
      CapabilityIntegrityError,
    );
    const allowedSkill = '---\nname: registos\ndescription: d\n"allowed-tools": bash\n---\nCorpo\n';
    const allowed = capabilities();
    allowed.manifest.skills[0]!.files[0] = { path: 'SKILL.md', sha256: sha(allowedSkill), size: 1 };
    allowed.files.v1![0] = { path: 'SKILL.md', content: allowedSkill, sha256: sha(allowedSkill) };
    await expect(materializeCapabilities(base, allowed)).rejects.toBeInstanceOf(
      CapabilityIntegrityError,
    );
  });
});

describe('compilação para o SDK', () => {
  it('gera agente principal, especialistas sem delegação e skills nativas', () => {
    const { config, tools } = compileSessionCapabilities(
      { manifest: capabilities().manifest, skillDirectory: '/jobs/skills' },
      'bash',
    );
    expect(config.agent).toBe('principal');
    expect(config.enableConfigDiscovery).toBe(false);
    expect(config).toMatchObject({ enableSkills: true, skillDirectories: ['/jobs/skills'] });
    const [main, delegate] = config.customAgents;
    expect(main).toMatchObject({ name: 'principal', infer: false, tools: null });
    expect(delegate).toMatchObject({ name: 'leitor', infer: true });
    expect(delegate?.tools).toContain('bash');
    expect(delegate?.tools).not.toContain('task');
    expect(delegate?.tools).not.toContain('edit');
    expect(tools).toEqual(['skill', 'task']);
    const noConnectors = compileSessionCapabilities(
      {
        manifest: capabilities({ delegates: [agent('leitor')], skills: [] }).manifest,
        skillDirectory: null,
      },
      'bash',
    );
    expect(noConnectors.config.customAgents[1]?.tools).not.toContain('bash');
    expect(noConnectors.config).not.toHaveProperty('skillDirectories');
    expect(noConnectors.tools).toEqual(['task']);
  });
});

describe('guarda de capacidades no onPreToolUse', () => {
  it('limita skills e especialistas ao manifesto fixado e à concorrência definida', () => {
    const guard = new CapabilityToolGuard(capabilities().manifest);
    expect(guard.check({ toolName: 'skill', toolArgs: { skill: 'registos' } })).toBeUndefined();
    expect(guard.check({ toolName: 'skill', toolArgs: { skill: 'outra' } })).toMatchObject({
      permissionDecision: 'deny',
    });
    expect(
      guard.check({ toolName: 'task', toolArgs: { agent_type: 'general-purpose' } }),
    ).toMatchObject({ permissionDecision: 'deny' });
    expect(
      guard.check({ toolName: 'task', toolArgs: { agent_type: 'leitor' }, toolCallId: 't1' }),
    ).toBeUndefined();
    expect(
      guard.check({ toolName: 'task', toolArgs: { agent_type: 'leitor' }, toolCallId: 't2' }),
    ).toMatchObject({ permissionDecision: 'deny' });
    guard.release('t1');
    expect(
      guard.check({ toolName: 'task', toolArgs: { agent_type: 'leitor' }, toolCallId: 't3' }),
    ).toBeUndefined();
    // Nunca aprova: ferramentas comuns seguem para a PermissionPolicy.
    expect(guard.check({ toolName: 'view', toolArgs: {} })).toBeUndefined();
  });

  it('sem posse ou após cancelamento recusa qualquer nova chamada, incluindo especialistas', () => {
    let active = true;
    const guard = new CapabilityToolGuard(capabilities().manifest, () => active);
    active = false;
    for (const call of [
      { toolName: 'task', toolArgs: { agent_type: 'leitor' } },
      { toolName: 'skill', toolArgs: { skill: 'registos' } },
      { toolName: 'view', toolArgs: {} },
    ])
      expect(guard.check(call)).toMatchObject({ permissionDecision: 'deny' });
    expect(guard.active).toBe(0);
  });

  it('sem manifesto não há skills nem especialistas', () => {
    const guard = new CapabilityToolGuard(null);
    expect(guard.check({ toolName: 'skill', toolArgs: { skill: 'registos' } })).toBeDefined();
    expect(guard.check({ toolName: 'task', toolArgs: { agent_type: 'leitor' } })).toBeDefined();
  });

  it('recusa delegação sem toolCallId (não seria possível libertar a vaga)', () => {
    const guard = new CapabilityToolGuard(capabilities().manifest);
    expect(guard.check({ toolName: 'task', toolArgs: { agent_type: 'leitor' } })).toMatchObject({
      permissionDecision: 'deny',
    });
    expect(guard.active).toBe(0);
  });
});

describe('eventos e transportes', () => {
  const redact = createRedactor([]);
  it('mapeia skills e especialistas para eventos de capacidade correlacionados', () => {
    expect(
      mapSessionEvent(
        { type: 'skill.invoked', data: { name: 'registos', trigger: 'model' } },
        redact,
      ),
    ).toMatchObject({ type: 'capability', kind: 'skill', name: 'registos', phase: 'invoked' });
    expect(
      mapSessionEvent(
        {
          type: 'subagent.started',
          data: { toolCallId: 't1', agentName: 'leitor', agentDisplayName: 'Leitor' },
        },
        redact,
      ),
    ).toMatchObject({ type: 'capability', kind: 'specialist', phase: 'started', toolCallId: 't1' });
    expect(
      mapSessionEvent(
        { type: 'subagent.failed', data: { toolCallId: 't1', agentName: 'leitor', error: 'boom' } },
        redact,
      ),
    ).toMatchObject({ kind: 'specialist', phase: 'failed', detail: 'boom' });
  });

  it('o transporte CLI recusa capacidades em vez de as ignorar', async () => {
    const adapter = new CopilotCliAdapter({
      async run() {
        return { exitCode: 0, interrupted: false };
      },
    });
    await expect(
      adapter.execute({
        mode: 'analysis' as never,
        prompt: 'x',
        timeoutMs: 1000,
        outputLimitBytes: 1000,
        workspace: await root(),
        capabilities: { manifest: capabilities().manifest, skillDirectory: null },
      }),
    ).rejects.toThrow('transporte SDK');
  });
});
