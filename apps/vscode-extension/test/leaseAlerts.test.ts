import { describe, expect, it } from 'vitest';
import { holderIsDead } from '../src/collector';
import { Store } from '../src/core/store';
import type { AlertRecord } from '../src/core/types';
import { groupAlerts } from '../src/core/viewmodel';

const NOW = new Date('2030-01-15T13:00:00Z');
const TEN_MIN = 10 * 60000;
// A PID far above any real one: the process does not exist.
const GONE = 'agent-2147483000';

describe('collector lease', () => {
  it('a holder whose process is gone frees the lease at once; a live one keeps it until it expires', () => {
    expect(holderIsDead(GONE)).toBe(true);
    expect(holderIsDead(`ext-${process.ppid}-ab12cd`)).toBe(false);
    expect(holderIsDead(`agent-${process.pid}`)).toBe(false);
    expect(holderIsDead('otro-formato')).toBe(false);

    const s = new Store(':memory:');
    expect(s.tryLease('collector', GONE, NOW, TEN_MIN)).toBe(true);
    // Without the check (old behaviour) the new agent waits for the expiry…
    expect(s.tryLease('collector', 'agent-1', NOW, TEN_MIN)).toBe(false);
    // …with it, it takes the lease of the dead process right away.
    expect(s.tryLease('collector', 'agent-1', NOW, TEN_MIN, holderIsDead)).toBe(true);

    const live = new Store(':memory:');
    expect(live.tryLease('collector', `agent-${process.ppid}`, NOW, TEN_MIN)).toBe(true);
    expect(live.tryLease('collector', 'agent-1', NOW, TEN_MIN, holderIsDead)).toBe(false);
    expect(live.tryLease('collector', 'agent-1', new Date(NOW.getTime() + TEN_MIN + 1000), TEN_MIN, holderIsDead)).toBe(true);
  });
});

describe('alert groups', () => {
  const alert = (createdAt: string, message: string, kind: AlertRecord['kind'] = 'stale', acknowledged = false): AlertRecord => ({
    alertKey: createdAt + message,
    accountId: 'claude-principal',
    severity: kind === 'threshold' ? 'warning' : 'info',
    kind,
    message,
    createdAt,
    acknowledged,
  });

  it('repeats of the same alert (only the «último» time differs) become one line with count and first time', () => {
    const g = groupAlerts(
      [
        alert('2030-01-15T17:58:00Z', 'Claude · principal · 7 d: dato desactualizado (último 15/01/2030, 12:24).'),
        alert('2030-01-15T17:13:00Z', 'Claude · principal · 7 d: dato desactualizado (último 15/01/2030, 11:40).', 'stale', true),
        alert('2030-01-15T16:00:00Z', 'Claude · principal · 5 h: 85 % usado (umbral 85 %).', 'threshold'),
        alert('2030-01-14T17:05:00Z', 'Claude · principal · 7 d: dato desactualizado (último 14/01/2030, 10:10).'),
      ],
      'America/Guayaquil',
    );
    expect(g).toHaveLength(2);
    expect(g[0]).toMatchObject({
      count: 3,
      message: 'Claude · principal · 7 d: dato desactualizado (último 15/01/2030, 12:24).',
      lastLocal: '15/01/2030, 12:58',
      firstLocal: '14/01/2030, 12:05',
      acknowledged: false,
    });
    expect(g[1]).toMatchObject({ count: 1, severity: 'warning' });
  });
});
