// Names on a library page line are rendered as "🟢 **Name** — @owners" (list) or
// "• Name *(shared from @x)*" (mine); this recovers just the game name.
export function extractListName(line: string): string {
  const bold = /\*\*(.+?)\*\*/.exec(line);
  if (bold) return bold[1];
  return line
    .replace(/^[•\s]+/, '')
    .replace(/\s+\*\(shared from .*$/, '')
    .trim();
}

export type JumpResult = { pageIndex: number } | { error: string };

// Resolves what a member typed into a "go to page" box: a page number, or the
// start of a game's name — since the lists are alphabetical, "wing" is a much
// quicker way to reach Wingspan than guessing which of 40 pages it's on.
// Name matching prefers a title that starts with the text, falling back to one
// that merely contains it.
export function resolveJumpTarget(input: string, pages: string[]): JumpResult {
  const text = input.trim();
  if (!text) return { error: 'Enter a page number or the start of a game name.' };

  if (/^\d+$/.test(text)) {
    const page = parseInt(text, 10);
    if (page < 1 || page > pages.length) return { error: `Pick a page between 1 and ${pages.length}.` };
    return { pageIndex: page - 1 };
  }

  const query = text.toLowerCase();
  const namesByPage = pages.map((page) => page.split('\n').map((line) => extractListName(line).toLowerCase()));
  for (const match of [(n: string) => n.startsWith(query), (n: string) => n.includes(query)]) {
    const idx = namesByPage.findIndex((names) => names.some(match));
    if (idx !== -1) return { pageIndex: idx };
  }
  return { error: `No game matching "${text}" on this list.` };
}
