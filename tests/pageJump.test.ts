import { describe, it, expect } from 'vitest';
import { extractListName, resolveJumpTarget } from '../src/utils/pageJump';

const PAGES = [
  ['🟢 **Azul** — <@1>', '🟡 **Brass: Birmingham** — <@2>, <@3>'].join('\n'),
  ['**Catan** — <@1>', '🔴 **Gloomhaven** — <@2>'].join('\n'),
  ['🟡 **Wingspan** — <@1>', '**Wingspan: Asia** — <@2>', '🟢 **Wonders Duel** — <@3>'].join('\n'),
];

describe('extractListName', () => {
  it('reads the bold game name from a /library list line', () => {
    expect(extractListName('🔴 **Gloomhaven** — <@2>')).toBe('Gloomhaven');
    expect(extractListName('**Brass: Birmingham** — <@2>')).toBe('Brass: Birmingham');
  });

  it('reads the plain name from a /library mine line, dropping the shared-from note', () => {
    expect(extractListName('• Wingspan')).toBe('Wingspan');
    expect(extractListName('• Root *(shared from <@5>)*')).toBe('Root');
  });
});

describe('resolveJumpTarget', () => {
  it('treats a number as a 1-based page', () => {
    expect(resolveJumpTarget('1', PAGES)).toEqual({ pageIndex: 0 });
    expect(resolveJumpTarget(' 3 ', PAGES)).toEqual({ pageIndex: 2 });
  });

  it('rejects pages outside the range', () => {
    expect(resolveJumpTarget('0', PAGES)).toEqual({ error: 'Pick a page between 1 and 3.' });
    expect(resolveJumpTarget('4', PAGES)).toEqual({ error: 'Pick a page between 1 and 3.' });
  });

  it('finds the page whose game name starts with the text, case-insensitively', () => {
    expect(resolveJumpTarget('wing', PAGES)).toEqual({ pageIndex: 2 });
    expect(resolveJumpTarget('CATAN', PAGES)).toEqual({ pageIndex: 1 });
    expect(resolveJumpTarget('brass', PAGES)).toEqual({ pageIndex: 0 });
  });

  it('prefers a name that starts with the text over one that merely contains it', () => {
    // "duel" is contained in "Wonders Duel" (page 3); nothing starts with it.
    expect(resolveJumpTarget('duel', PAGES)).toEqual({ pageIndex: 2 });
    // "haven" only appears inside "Gloomhaven".
    expect(resolveJumpTarget('haven', PAGES)).toEqual({ pageIndex: 1 });
    // "a" starts Azul (page 1) even though later pages contain "a" too.
    expect(resolveJumpTarget('a', PAGES)).toEqual({ pageIndex: 0 });
  });

  it('reports no match and rejects blank input', () => {
    expect(resolveJumpTarget('zzz', PAGES)).toEqual({ error: 'No game matching "zzz" on this list.' });
    expect(resolveJumpTarget('   ', PAGES)).toEqual({ error: 'Enter a page number or the start of a game name.' });
  });

  it('does not match against owner mentions', () => {
    expect(resolveJumpTarget('<@2>', PAGES)).toEqual({ error: 'No game matching "<@2>" on this list.' });
  });
});
