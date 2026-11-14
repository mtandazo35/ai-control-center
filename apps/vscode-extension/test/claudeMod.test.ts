import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { feedToSnapshots, ingestClaudeModInbox, profileForConfigDir, type ModFeed } from '../src/adapters/claudeMod';
import { estimateClaudeSession } from '../src/adapters/claudeUsage';
import { Store } from '../src/core/store';
import { buildViewModel, gatherInput } from '../src/core/viewmodel';
import { profile, settings, tmpDir } from './helpers';

// Synthetic feed in the exact shape the «ai-control-center-feed» mod writes (session.measure figures).
function feed(over: Partial<ModFeed> = {}): ModFeed {
  return {
    source: 'claude-mod',
    version: '0.1.0',
    observedAt: '2030-01-08T15:00:00.000Z',
    sessionId: 'sess-1',
    claudeConfigDir: null,
    rateLimits: [
      { kind: 'five_hour', percentUsed: 23.5, resetsAt: '2030-01-08T18:30:00.000Z' },
      { kind: 'seven_day', percentUsed: 41, resetsAt: '2030-01-10T08:00:00.000Z' },
    ],
    context: { percent: 64, tokens: 128000, window: 200000 },
    costUsd: 3.21,
    ...over,
  };
}

function setup() {
  const s = new Store(':memory:');
  const claudeDir = tmpDir('claude-cfg');
  const p = profile('claude', 'claude-a', 'A', claudeDir);
  s.upsertProfile(p);
  const dataDir = tmpDir('acc-data');
  return { s, p, claudeDir, dataDir, inbox: path.join(dataDir, 'inbox') };
}

describe('Claude Code mod feed (official session.measure figures, in every surface)', () => {
  it('maps the windows with the same ids as the other Claude sources', () => {
    const snaps = feedToSnapshots('claude-a', feed());
    expect(snaps.map((x) => [x.limitId, x.limitLabel, x.windowMinutes, x.usedPercent, x.remainingPercent])).toEqual([
      ['five_hour', '5 h', 300, 23.5, 76.5],
      ['seven_day', '7 d', 10080, 41, 59],
    ]);
    expect(snaps[0]).toMatchObject({ source: 'claude-mod', confidence: 'high', status: 'live' });
  });

  it('attributes the file to the profile whose CLAUDE_CONFIG_DIR wrote it', () => {
    const { p, claudeDir } = setup();
    expect(profileForConfigDir([p], claudeDir)?.id).toBe('claude-a');
    expect(profileForConfigDir([p], path.join(claudeDir, 'otra'))).toBeUndefined();
  });

  it('ingests quotas, session, cost and context; idempotent; creates the inbox', () => {
    const { s, claudeDir, dataDir, inbox } = setup();
    expect(ingestClaudeModInbox(s, dataDir, 'm1')).toBe(0);
    expect(fs.existsSync(inbox)).toBe(true); // created so the mod can write
    fs.writeFileSync(path.join(inbox, 'claude-mod-sess-1.json'), JSON.stringify(feed({ claudeConfigDir: claudeDir })));
    expect(ingestClaudeModInbox(s, dataDir, 'm1')).toBe(2);
    expect(ingestClaudeModInbox(s, dataDir, 'm1')).toBe(0); // unchanged file
    expect(s.latestQuotas().find((q) => q.limitId === 'five_hour')).toMatchObject({ usedPercent: 23.5, source: 'claude-mod' });
    expect(s.dumpTable('cost_events')[0]).toMatchObject({ amount: 3.21, cost_basis: 'estimated' });
    const now = new Date('2030-01-08T15:05:00Z');
    const pv = buildViewModel(gatherInput(s, '24h', now), settings, '24h', now).profiles[0];
    expect(pv.sessionContext?.percent).toBe(64);
    expect(pv.buckets.find((b) => b.limitId === 'five_hour')).toMatchObject({ usedPercent: 23.5, state: 'live', resetText: 'Se reinicia a las 13:30' });
    // A half-written or foreign file is ignored, never crashes the collector.
    fs.writeFileSync(path.join(inbox, 'claude-mod-roto.json'), '{"source":"claude-mod","rateLimi');
    expect(() => ingestClaudeModInbox(s, dataDir, 'm1')).not.toThrow();
  });

  it('with a live mod reading the 5-hour window is never replaced by the estimate', () => {
    const { s, claudeDir, dataDir, inbox } = setup();
    s.upsertTokenEvent({ eventKey: 'e1', accountId: 'claude-a', sessionId: 's', model: 'm', inputTokens: 1, outputTokens: 1, cachedTokens: 0, timestamp: '2030-01-08T13:35:00.000Z', source: 'claude-transcript' });
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, 'claude-mod-sess-1.json'), JSON.stringify(feed({ claudeConfigDir: claudeDir })));
    ingestClaudeModInbox(s, dataDir, 'm1');
    expect(estimateClaudeSession(s, 'claude-a', 'm1', new Date('2030-01-08T15:10:00Z'))).toBe(false);
    expect(s.latestQuotas().find((q) => q.limitId === 'five_hour')?.usedPercent).toBe(23.5);
  });
});
