import { describe, expect, it } from 'vitest';
import { emptyUsage, UsageAccumulator } from '../../../packages/contracts/src/index.js';
import { createRedactor, mapSessionEvent } from './session-event-mapper.js';

const redact = createRedactor([]);

describe('assistant usage billing', () => {
  it('preserves unavailable billing, explicit zero, partial subtotals and fractional credits', () => {
    const mapped = (data: Record<string, unknown>) =>
      mapSessionEvent({ type: 'assistant.usage', data: { model: 'gpt-5', ...data } }, redact);
    expect(mapped({})).toMatchObject({
      cost: null,
      aiCredits: null,
      aiCreditsStatus: 'unavailable',
    });
    expect(mapped({ cost: 0 })).toMatchObject({
      cost: 0,
      aiCredits: null,
      aiCreditsStatus: 'unavailable',
    });
    expect(mapped({ copilotUsage: { totalNanoAiu: 0 } })).toMatchObject({
      billingUnit: 'ai_credits',
      aiCredits: 0,
      aiCreditsStatus: 'complete',
    });
    expect(
      mapped({ cost: 1, copilotUsage: { totalNanoAiu: 125_000 }, aiCreditsStatus: 'partial' }),
    ).toMatchObject({
      cost: 1,
      billingUnit: 'ai_credits',
      aiCredits: 0.000125,
      aiCreditsStatus: 'partial',
    });
    expect(
      mapped({ copilotUsage: { totalNanoAiu: 0 }, aiCreditsStatus: 'unavailable' }),
    ).toMatchObject({ aiCredits: 0, aiCreditsStatus: 'unavailable' });
    expect(
      mapped({ copilotUsage: { totalNanoAiu: NaN }, aiCreditsStatus: 'complete' }),
    ).toMatchObject({ aiCredits: null, aiCreditsStatus: 'unavailable' });
  });

  it('maps accounting receipts and concrete Fusion calls but ignores aggregate phase/snapshot totals', () => {
    const usage = emptyUsage();
    const accumulator = new UsageAccumulator();
    const events = [
      {
        id: 'event-1',
        type: 'assistant.usage',
        data: {
          model: 'hydrafusion',
          fusion: { fusionId: 'fusion-1', phaseId: 'phase-1', sourceModel: 'gpt-5' },
          accounting: { sourceSessionId: 'session-1', sequence: 1, usageId: 'receipt-1' },
          apiCallId: 'api-1',
          copilotUsage: { totalNanoAiu: 100_000_000 },
          inputTokens: 100,
          cacheWriteTokens: 20,
        },
      },
      {
        id: 'event-2',
        type: 'assistant.usage',
        data: {
          model: 'claude-sonnet-4.5',
          fusion: { fusionId: 'fusion-1', phaseId: 'phase-1' },
          accounting: { sourceSessionId: 'session-1', sequence: 2, usageId: 'receipt-2' },
          apiCallId: 'api-2',
          copilotUsage: { totalNanoAiu: 200_000_000 },
          inputTokens: 50,
        },
      },
      {
        type: 'assistant.fusion_phase_completed',
        data: { fusionId: 'fusion-1', phaseId: 'phase-1', usage: { totalNanoAiu: 300_000_000 } },
      },
      { type: 'session.fusion_turn_completed', data: { totalNanoAiu: 300_000_000 } },
      { type: 'session.usage_checkpoint', data: { totalNanoAiu: 300_000_000 } },
      { type: 'session.shutdown', data: { totalNanoAiu: 300_000_000 } },
    ];
    for (const event of [...events, ...events]) {
      const mapped = mapSessionEvent(event, redact);
      if (mapped?.type === 'usage') accumulator.add(mapped, usage);
      else expect(mapped).toBeNull();
    }
    expect(usage).toMatchObject({
      aiCredits: expect.closeTo(0.3),
      aiCreditsStatus: 'complete',
      premiumRequests: 0,
      modelCalls: 2,
      inputTokens: 150,
      cacheWriteTokens: 20,
      models: ['gpt-5', 'claude-sonnet-4.5'],
    });
  });
});
