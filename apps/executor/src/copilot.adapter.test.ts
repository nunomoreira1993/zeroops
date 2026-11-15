import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopilotCliAdapter, type SandboxProcess } from './copilot.adapter.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});
async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'zeroops-copilot-test-'));
  directories.push(directory);
  return directory;
}
const limits = {
  mode: 'implement' as const,
  prompt: 'Corrigir fixture autorizada.',
  timeoutMs: 1000,
  outputLimitBytes: 10000,
};

describe('contrato Copilot sem executar agente real', () => {
  it('mede hashes reais e nao considera comandos propostos testes aprovados', async () => {
    const directory = await workspace();
    const sandbox: SandboxProcess = {
      async run(input) {
        expect(input.arguments).not.toContain('--yolo');
        expect(input.arguments).toContain('--deny-tool=shell');
        await writeFile(join(directory, 'fixture.php'), '<?php echo "fixture";');
        await writeFile(
          join(directory, '.zeroops-result.json'),
          JSON.stringify({
            summary: 'Candidato',
            files: [{ path: 'fixture.php' }],
            proposedTests: ['php -l fixture.php'],
          }),
        );
        return { exitCode: 0, interrupted: false };
      },
    };
    const result = await new CopilotCliAdapter(sandbox).execute({
      ...limits,
      workspace: directory,
    });
    expect(result.files[0]?.sha256).toHaveLength(64);
    expect(result.verifiedTests).toBe(false);
  });
  it('ignora evidencias nao pedidas no desenvolvimento mas valida-as na investigacao', async () => {
    const report = {
      summary: 'Candidato',
      files: [],
      proposedTests: [],
      evidence: [{ source: 'app.js', finding: 'sem detail', environment: 'quality' }],
    };
    const adapter = (directory: string) =>
      new CopilotCliAdapter({
        async run() {
          await writeFile(join(directory, '.zeroops-result.json'), JSON.stringify(report));
          return { exitCode: 0, interrupted: false };
        },
      });
    const implement = await workspace();
    const result = await adapter(implement).execute({ ...limits, workspace: implement });
    expect(result.evidence).toEqual([]);
    const investigate = await workspace();
    await expect(
      adapter(investigate).execute({ ...limits, mode: 'investigate', workspace: investigate }),
    ).rejects.toThrow();
  });
  it('recusa sucesso aparente sem resultado e paths externos', async () => {
    const directory = await workspace();
    const adapter = new CopilotCliAdapter({
      async run() {
        return { exitCode: 0, interrupted: false };
      },
    });
    await expect(adapter.execute({ ...limits, workspace: directory })).rejects.toThrow();
    const malicious = new CopilotCliAdapter({
      async run() {
        await writeFile(
          join(directory, '.zeroops-result.json'),
          JSON.stringify({
            summary: 'Invalido',
            files: [{ path: '../outside.php' }],
            proposedTests: [],
          }),
        );
        return { exitCode: 0, interrupted: false };
      },
    });
    await expect(malicious.execute({ ...limits, workspace: directory })).rejects.toThrow('Caminho');
    await expect(adapter.execute({ ...limits, workspace: directory })).rejects.toThrow(
      'reutilizado',
    );
  });
  it('so expoe a shell para os comandos dos conectores e passa o token do run', async () => {
    const directory = await workspace();
    let seen: Parameters<SandboxProcess['run']>[0] | undefined;
    const adapter = new CopilotCliAdapter({
      async run(input) {
        seen = input;
        await writeFile(
          join(directory, '.zeroops-result.json'),
          JSON.stringify({ summary: 'Ok', files: [], proposedTests: [], replyDraft: null }),
        );
        return { exitCode: 0, interrupted: false };
      },
    });
    await adapter.execute({
      ...limits,
      mode: 'investigate',
      workspace: directory,
      shell: { tool: 'bash', commands: ['zo-sql', 'zo-loki'] },
      env: { ZEROOPS_RUN_TOKEN: 'abc' },
    });
    expect(seen?.arguments).toContain(
      '--available-tools=view,grep,glob,create,edit,apply_patch,bash',
    );
    expect(seen?.arguments).toContain('--allow-tool=shell(zo-sql:*)');
    expect(seen?.arguments).toContain('--allow-tool=shell(zo-loki:*)');
    expect(seen?.arguments).not.toContain('--allow-tool=shell');
    expect(seen?.arguments).not.toContain('--deny-tool=shell');
    expect(seen?.arguments.some((arg) => arg.startsWith('--secret-env-vars='))).toBe(true);
    expect(seen?.env).toEqual({ ZEROOPS_RUN_TOKEN: 'abc' });
    await expect(
      adapter.execute({
        ...limits,
        mode: 'investigate',
        workspace: await workspace(),
        shell: { tool: 'bash', commands: ['rm -rf'] },
      }),
    ).rejects.toThrow('Comando');
  });
  it('interrupcao nunca produz candidato', async () => {
    const directory = await workspace();
    const adapter = new CopilotCliAdapter({
      async run() {
        return { exitCode: 0, interrupted: true };
      },
    });
    await expect(adapter.execute({ ...limits, workspace: directory })).rejects.toThrow(
      'reconciliacao',
    );
  });
});
