import { describe, it, expect } from 'vitest';
import {
  MAX_GREETERS,
  isGreeter,
  greeterSeatViolation,
  GREETER_COMPLEXITY_MESSAGE,
  GREETER_CONFLICT_MESSAGE,
} from '../src/utils/greeters';

describe('MAX_GREETERS', () => {
  it('is 2', () => {
    expect(MAX_GREETERS).toBe(2);
  });
});

describe('isGreeter', () => {
  it('is false when the event has no greeters set', () => {
    expect(isGreeter({}, 'u1')).toBe(false);
    expect(isGreeter({ greeters: [] }, 'u1')).toBe(false);
  });

  it('is true only for users listed as greeters', () => {
    expect(isGreeter({ greeters: ['u1', 'u2'] }, 'u1')).toBe(true);
    expect(isGreeter({ greeters: ['u1', 'u2'] }, 'u2')).toBe(true);
    expect(isGreeter({ greeters: ['u1', 'u2'] }, 'u3')).toBe(false);
  });
});

describe('greeterSeatViolation', () => {
  function makeGame(overrides: Partial<{ complexity: string; seats: string[]; waitlist: string[] }> = {}) {
    return {
      complexity: overrides.complexity,
      seats: overrides.seats ?? [],
      waitlist: overrides.waitlist ?? [],
    };
  }

  it('allows a non-greeter to join any game regardless of complexity', () => {
    expect(greeterSeatViolation({ greeters: ['g1'] }, makeGame({ complexity: 'Heavy' }), 'not-a-greeter')).toBeNull();
  });

  it('allows a greeter to join a Light game', () => {
    expect(greeterSeatViolation({ greeters: ['g1'] }, makeGame({ complexity: 'Light' }), 'g1')).toBeNull();
  });

  it('blocks a greeter from a Medium or Heavy game', () => {
    expect(greeterSeatViolation({ greeters: ['g1'] }, makeGame({ complexity: 'Medium' }), 'g1')).toBe(
      GREETER_COMPLEXITY_MESSAGE,
    );
    expect(greeterSeatViolation({ greeters: ['g1'] }, makeGame({ complexity: 'Heavy' }), 'g1')).toBe(
      GREETER_COMPLEXITY_MESSAGE,
    );
  });

  it('blocks a greeter from a game with unknown/unconfirmed complexity', () => {
    expect(greeterSeatViolation({ greeters: ['g1'] }, makeGame({ complexity: undefined }), 'g1')).toBe(
      GREETER_COMPLEXITY_MESSAGE,
    );
  });

  it('blocks the second greeter from joining a Light game the other greeter is already seated on', () => {
    const gn = { greeters: ['g1', 'g2'] };
    const game = makeGame({ complexity: 'Light', seats: ['g1'] });
    expect(greeterSeatViolation(gn, game, 'g2')).toBe(GREETER_CONFLICT_MESSAGE);
  });

  it('blocks the second greeter from waitlisting a Light game the other greeter is already on', () => {
    const gn = { greeters: ['g1', 'g2'] };
    const game = makeGame({ complexity: 'Light', waitlist: ['g1'] });
    expect(greeterSeatViolation(gn, game, 'g2')).toBe(GREETER_CONFLICT_MESSAGE);
  });

  it('allows both greeters to join separate Light games', () => {
    const gn = { greeters: ['g1', 'g2'] };
    expect(greeterSeatViolation(gn, makeGame({ complexity: 'Light', seats: ['someone-else'] }), 'g2')).toBeNull();
  });

  it('is unaffected by a solo greeter (no conflict check possible with only 1)', () => {
    const gn = { greeters: ['g1'] };
    expect(greeterSeatViolation(gn, makeGame({ complexity: 'Light' }), 'g1')).toBeNull();
  });
});
