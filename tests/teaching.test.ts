import { describe, it, expect } from 'vitest';
import {
  initialTeaching,
  removeFromTeaching,
  toggleTeacher,
  findGamesNeedingTeacher,
  buildTeacherHostMessage,
  isTeachingLevel,
} from '../src/utils/teaching';
import { GameSuggestion } from '../src/utils/gameStorage';

function game(overrides: Partial<GameSuggestion> = {}): GameSuggestion {
  return {
    id: 'g1',
    title: 'Wingspan',
    seats: ['u1'],
    waitlist: [],
    teachers: [],
    helpers: [],
    ...overrides,
  } as GameSuggestion;
}

describe('initialTeaching', () => {
  it('makes a "teach" suggester a teacher', () => {
    expect(initialTeaching('u1', 'teach')).toEqual({ teachers: ['u1'], helpers: [] });
  });
  it('makes an "answer" suggester a question-answerer only', () => {
    expect(initialTeaching('u1', 'answer')).toEqual({ teachers: [], helpers: ['u1'] });
  });
  it('lists nobody for a suggester who is new to the game', () => {
    expect(initialTeaching('u1', 'learning')).toEqual({ teachers: [], helpers: [] });
  });
});

describe('isTeachingLevel', () => {
  it('accepts only the three known levels', () => {
    expect(isTeachingLevel('teach')).toBe(true);
    expect(isTeachingLevel('answer')).toBe(true);
    expect(isTeachingLevel('learning')).toBe(true);
    expect(isTeachingLevel('expert')).toBe(false);
  });
});

describe('toggleTeacher', () => {
  it('adds a teacher and reports true, then removes them and reports false', () => {
    const g = game();
    expect(toggleTeacher(g, 'u1')).toBe(true);
    expect(g.teachers).toEqual(['u1']);
    expect(toggleTeacher(g, 'u1')).toBe(false);
    expect(g.teachers).toEqual([]);
  });

  it('moves a question-answerer up to teacher instead of listing them twice', () => {
    const g = game({ helpers: ['u1'] });
    toggleTeacher(g, 'u1');
    expect(g.teachers).toEqual(['u1']);
    expect(g.helpers).toEqual([]);
  });

  it('works on a legacy game with no teaching lists yet', () => {
    const g = game({ teachers: undefined, helpers: undefined });
    expect(toggleTeacher(g, 'u1')).toBe(true);
    expect(g.teachers).toEqual(['u1']);
  });
});

describe('removeFromTeaching', () => {
  it('drops the user from both lists', () => {
    const g = game({ teachers: ['u1', 'u2'], helpers: ['u1', 'u3'] });
    removeFromTeaching(g, 'u1');
    expect(g.teachers).toEqual(['u2']);
    expect(g.helpers).toEqual(['u3']);
  });

  it('leaves a legacy game (no lists) untouched', () => {
    const g = game({ teachers: undefined, helpers: undefined });
    removeFromTeaching(g, 'u1');
    expect(g.teachers).toBeUndefined();
  });
});

describe('findGamesNeedingTeacher', () => {
  it('flags a seated game with an empty teachers list', () => {
    expect(findGamesNeedingTeacher([game()]).map((g) => g.id)).toEqual(['g1']);
  });

  it('skips games that have a teacher', () => {
    expect(findGamesNeedingTeacher([game({ teachers: ['u1'] })])).toEqual([]);
  });

  it('skips legacy games with no teaching data', () => {
    expect(findGamesNeedingTeacher([game({ teachers: undefined })])).toEqual([]);
  });

  it('skips games nobody is seated in, or only guests are', () => {
    expect(findGamesNeedingTeacher([game({ seats: [] })])).toEqual([]);
    expect(findGamesNeedingTeacher([game({ seats: ['guest:abc'] })])).toEqual([]);
  });
});

describe('buildTeacherHostMessage', () => {
  it('names the event and each game, noting where someone can answer questions', () => {
    const msg = buildTeacherHostMessage('Game Night', [
      game({ title: 'Wingspan' }),
      game({ id: 'g2', title: 'Catan', helpers: ['u2'] }),
    ]);
    expect(msg).toContain('Game Night');
    expect(msg).toContain('**Wingspan**');
    expect(msg).toContain('**Catan** (someone can answer questions)');
  });
});
