import { describe, expect, it } from 'vitest';
import { approveStage } from './approval.js';

const input = {
  status: 'awaiting_client',
  version: 2,
  expectedVersion: 2,
  hash: 'a'.repeat(64),
  expectedHash: 'a'.repeat(64),
  role: 'client',
  decision: 'approve',
  notes: '',
} as const;

describe('aprovar uma versao concreta', () => {
  it('separa cliente, tecnico, QA e release', () => {
    expect(approveStage(input)).toBe('awaiting_technical');
    expect(() => approveStage({ ...input, role: 'admin' })).toThrow('Papel');
    expect(approveStage({ ...input, status: 'awaiting_technical', role: 'technical' })).toBe(
      'implementing',
    );
    expect(approveStage({ ...input, status: 'awaiting_qa', role: 'qa' })).toBe('awaiting_release');
    expect(approveStage({ ...input, status: 'awaiting_release', role: 'release' })).toBe(
      'deploying',
    );
  });
  it('recusa versao antiga e alteracoes de um byte', () => {
    expect(() => approveStage({ ...input, expectedVersion: 1 })).toThrow('mudou');
    expect(() => approveStage({ ...input, expectedHash: 'b'.repeat(64) })).toThrow('mudou');
  });
  it('rejeicao exige motivo e volta a investigacao', () => {
    expect(() => approveStage({ ...input, decision: 'reject' })).toThrow('motivo');
    expect(approveStage({ ...input, decision: 'reject', notes: 'Falta um criterio.' })).toBe(
      'investigating',
    );
  });
});
