import { describe, expect, it } from 'vitest';
import { emptyUsage, UsageAccumulator, type AgentModelCall } from './agent-runs.js';

const call: AgentModelCall = {
  model: 'gpt-5',
  cost: null,
  initiator: null,
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 20,
  durationMs: null,
};

describe('UsageAccumulator', () => {
  it('distinguishes legacy fabricated zero, confirmed premium zero and known legacy premium', () => {
    const unknown = emptyUsage();
    new UsageAccumulator().add({ ...call, cost: 0 }, unknown);
    expect(unknown).toMatchObject({
      costStatus: 'legacy',
      costUnit: null,
      aiCredits: null,
    });
    const zero = emptyUsage();
    new UsageAccumulator().add({ ...call, cost: 0, billingUnit: 'premium_requests' }, zero);
    expect(zero).toMatchObject({
      premiumRequests: 0,
      costStatus: 'complete',
      costUnit: 'premium_requests',
    });
    const legacy = emptyUsage();
    const accumulator = new UsageAccumulator();
    accumulator.add({ ...call, cost: 1.5 }, legacy);
    accumulator.add({ ...call, cost: 1.5 }, legacy);
    accumulator.add({ ...call, cost: 1.5, initiator: 'sub-agent' }, legacy);
    accumulator.userRequest();
    accumulator.add({ ...call, cost: 1.5 }, legacy);
    expect(legacy).toMatchObject({ premiumRequests: 3, modelCalls: 4, costStatus: 'complete' });
  });

  it('counts all concrete credit receipts once across turns, even with repeated/out-of-order delivery', () => {
    const total = emptyUsage();
    const firstTurn = emptyUsage();
    const secondTurn = emptyUsage();
    const accumulator = new UsageAccumulator();
    const receipt = (sequence: number, aiCredits: number): AgentModelCall => ({
      ...call,
      cost: 3,
      billingUnit: 'ai_credits',
      aiCredits,
      aiCreditsStatus: 'complete',
      accounting: { sourceSessionId: 'main', sequence, usageId: `usage-${sequence}` },
    });
    accumulator.add(receipt(2, 0), firstTurn, total);
    accumulator.add(receipt(1, 0.000000001), firstTurn, total);
    accumulator.userRequest();
    accumulator.add(receipt(1, 0.000000001), secondTurn, total);
    accumulator.add({ ...receipt(3, 0.25), initiator: 'sub-agent' }, secondTurn, total);
    expect(total).toMatchObject({
      modelCalls: 3,
      aiCredits: 0.250000001,
      costUnit: 'ai_credits',
      costStatus: 'complete',
      premiumRequests: 0,
    });
    expect(firstTurn).toMatchObject({ modelCalls: 2, aiCredits: 0.000000001 });
    expect(secondTurn).toMatchObject({ modelCalls: 1, aiCredits: 0.25 });
    expect(total.modelUsage).toEqual([
      {
        model: 'gpt-5',
        modelCalls: 3,
        inputTokens: 300,
        outputTokens: 30,
        cacheReadTokens: 60,
        cacheWriteTokens: 0,
        aiCredits: 0.250000001,
        aiCreditsStatus: 'complete',
      },
    ]);
  });

  it('retains reported subtotals and never upgrades missing billing or partial zero to confirmed zero', () => {
    const usage = emptyUsage();
    const accumulator = new UsageAccumulator();
    accumulator.add({ ...call, aiCredits: 0, aiCreditsStatus: 'partial' }, usage);
    expect(usage).toMatchObject({ aiCredits: 0, costStatus: 'partial' });
    accumulator.add({ ...call, aiCredits: null, aiCreditsStatus: 'unavailable' }, usage);
    accumulator.add({ ...call, aiCredits: 0.125, aiCreditsStatus: 'complete' }, usage);
    expect(usage).toMatchObject({
      aiCredits: 0.125,
      aiCreditsStatus: 'partial',
      costStatus: 'partial',
    });
    const unavailable = emptyUsage();
    accumulator.add({ ...call, aiCredits: 0, aiCreditsStatus: 'unavailable' }, unavailable);
    expect(unavailable).toMatchObject({ aiCredits: 0, costStatus: 'unavailable' });
  });

  it('keeps billing units separate when legacy premium and credits coexist', () => {
    const usage = emptyUsage();
    const accumulator = new UsageAccumulator();
    accumulator.add({ ...call, cost: 1 }, usage);
    accumulator.add({ ...call, aiCredits: 0.25, aiCreditsStatus: 'complete' }, usage);
    accumulator.add({ ...call, aiCredits: 0.5, aiCreditsStatus: 'complete' }, usage);
    expect(usage).toMatchObject({
      premiumRequests: 1,
      aiCredits: 0.75,
      costUnit: null,
      costStatus: 'partial',
    });
  });

  it('deduplicates SDK/API identities while keeping sources and unidentified legacy calls distinct', () => {
    const usage = emptyUsage();
    const accumulator = new UsageAccumulator();
    accumulator.add({ ...call, apiCallId: 'api-1', sdkEventId: 'event-1' }, usage);
    accumulator.add({ ...call, apiCallId: 'api-1', sdkEventId: 'event-2' }, usage);
    accumulator.add({ ...call, sdkEventId: 'event-2' }, usage);
    accumulator.add(call, usage);
    accumulator.add(call, usage);
    for (const sourceSessionId of ['main', 'subagent']) {
      accumulator.add(
        {
          ...call,
          accounting: { sourceSessionId, sequence: 1, usageId: 'same-source-local-id' },
        },
        usage,
      );
    }
    expect(usage.modelCalls).toBe(5);
  });
});
