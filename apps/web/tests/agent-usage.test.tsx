import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyUsage, type AgentUsage } from '@zeroops/contracts';
import { UsageBadge } from '../src/features/tickets/AgentUsage';
import { sumUsage } from '../src/features/tickets/agent-run-timeline';

afterEach(cleanup);

const reported = (extra: Partial<AgentUsage> = {}): AgentUsage => ({
  ...emptyUsage(),
  costUnit: 'ai_credits',
  costStatus: 'complete',
  aiCreditsStatus: 'complete',
  aiCredits: 0,
  modelCalls: 2,
  inputTokens: 1200,
  outputTokens: 200,
  models: ['gpt-pro', 'claude-test'],
  ...extra,
});

describe('reported agent consumption', () => {
  it('distinguishes missing billing and legacy zero from confirmed zero credits', () => {
    const { rerender } = render(<UsageBadge usage={emptyUsage()} />);
    expect(screen.getByText('Custo indisponível')).toBeTruthy();
    expect(screen.queryByText(/0 créditos IA/)).toBeNull();
    rerender(
      <UsageBadge usage={{ ...emptyUsage(), costStatus: undefined, aiCreditsStatus: undefined }} />,
    );
    expect(screen.getByText('Custo indisponível · registo antigo')).toBeTruthy();
    rerender(<UsageBadge usage={reported()} />);
    expect(screen.getByText('0 créditos IA')).toBeTruthy();
    expect(screen.queryByText(/premium requests$/)).toBeNull();
  });

  it('keeps tiny reported fractions visible, without token-based or promotional discounts', () => {
    render(
      <UsageBadge
        usage={reported({
          aiCredits: 0.000000001,
          costStatus: 'partial',
          aiCreditsStatus: 'partial',
        })}
      />,
    );
    expect(screen.getByText('0,000000001 créditos IA · subtotal')).toBeTruthy();
    expect(screen.getByText('Subtotal: custo de algumas chamadas indisponível.')).toBeTruthy();
  });

  it('never rounds a positive reported premium amount below precision to zero', () => {
    render(
      <UsageBadge
        usage={reported({
          aiCredits: null,
          aiCreditsStatus: 'unavailable',
          costUnit: 'premium_requests',
          premiumRequests: 0.00000000001,
        })}
      />,
    );
    expect(screen.getByText('<0,000000001 premium requests')).toBeTruthy();
    expect(screen.queryByText('0 premium requests')).toBeNull();
  });

  it('shows readable actual models and per-model multiple-call detail, not raw IDs in the summary', () => {
    const { container } = render(
      <UsageBadge
        usage={reported({
          modelUsage: [
            {
              model: 'gpt-pro',
              modelCalls: 2,
              inputTokens: 1000,
              outputTokens: 200,
              cacheReadTokens: 20,
              cacheWriteTokens: 5,
              aiCredits: 0.4,
              aiCreditsStatus: 'complete',
            },
          ],
        })}
        models={[
          {
            id: 'gpt-pro',
            name: 'GPT Pro',
            multiplier: null,
            efforts: [],
            defaultEffort: null,
            fusion: false,
          },
        ]}
      />,
    );
    const summary = container.querySelector('summary')!;
    expect(summary.textContent).not.toContain('gpt-pro');
    expect(summary.textContent).not.toContain('GPT Pro');
    fireEvent.click(summary);
    expect(screen.getByText('GPT Pro, Claude test')).toBeTruthy();
    expect(screen.getByText('GPT Pro')).toBeTruthy();
    expect(screen.getByText('20 / 5')).toBeTruthy();
    expect(screen.getByText('Copilot · nano-AIU / 1 000 000 000')).toBeTruthy();
  });

  it('aggregates confirmed zero, unknown runs and mixed units conservatively', () => {
    expect(sumUsage([reported(), reported()])).toMatchObject({
      aiCredits: 0,
      costStatus: 'complete',
      costUnit: 'ai_credits',
    });
    expect(sumUsage([reported({ aiCredits: 0.4 }), emptyUsage(), null])).toMatchObject({
      aiCredits: 0.4,
      costStatus: 'partial',
      aiCreditsStatus: 'partial',
    });
    const mixed = sumUsage([
      reported({ aiCredits: 0.4 }),
      reported({
        aiCredits: null,
        aiCreditsStatus: 'unavailable',
        costUnit: 'premium_requests',
        premiumRequests: 1,
      }),
    ])!;
    expect(mixed).toMatchObject({
      aiCredits: 0.4,
      premiumRequests: 1,
      costStatus: 'partial',
      costUnit: null,
    });
    render(<UsageBadge usage={mixed} />);
    expect(screen.getByText('Custo parcial · ver unidades')).toBeTruthy();
    expect(screen.getByText('Créditos IA reportados')).toBeTruthy();
    expect(screen.getByText('Premium requests')).toBeTruthy();
  });

  it('sums per-model calls and retains partial credit availability', () => {
    const entry = {
      model: 'gpt-pro',
      modelCalls: 2,
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
      aiCredits: 0.2,
      aiCreditsStatus: 'complete' as const,
    };
    const total = sumUsage([
      reported({ modelUsage: [entry] }),
      reported({
        costStatus: 'unavailable',
        aiCredits: null,
        modelUsage: [{ ...entry, aiCredits: null, aiCreditsStatus: 'unavailable' }],
      }),
    ]);
    expect(total?.modelUsage).toEqual([
      {
        ...entry,
        modelCalls: 4,
        inputTokens: 200,
        outputTokens: 20,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
        aiCredits: 0.2,
        aiCreditsStatus: 'partial',
      },
    ]);
  });
});
