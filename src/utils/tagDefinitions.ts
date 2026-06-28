export const GENRE_TAG_DEFINITIONS = [
  { name: 'Co-op',            color: '#2ecc71' },
  { name: 'Competitive',      color: '#e74c3c' },
  { name: 'Semi-Co-op',       color: '#1abc9c' },
  { name: 'Team vs Team',     color: '#e67e22' },
  { name: 'Solo Friendly',    color: '#00bcd4' },
  { name: 'Deck Building',    color: '#3498db' },
  { name: 'Engine Building',  color: '#5865f2' },
  { name: 'Worker Placement', color: '#9b59b6' },
  { name: 'Area Control',     color: '#e06c75' },
  { name: 'Tile Placement',   color: '#f0b232' },
  { name: 'Drafting',         color: '#f1c40f' },
  { name: 'Auction',          color: '#f0b232' },
  { name: 'Trick Taking',     color: '#e91e8c' },
  { name: 'Roll & Write',     color: '#95a5a6' },
  { name: 'Push Your Luck',   color: '#e67e22' },
  { name: 'Hand Management',  color: '#3498db' },
  { name: 'Social Deduction', color: '#e74c3c' },
  { name: 'Hidden Roles',     color: '#607d8b' },
  { name: 'Bluffing',         color: '#1abc9c' },
  { name: 'Party',            color: '#e91e8c' },
  { name: 'Abstract',         color: '#ffffff' },
  { name: 'Economic',         color: '#2ecc71' },
  { name: 'Dungeon Crawler',  color: '#9b59b6' },
  { name: 'Legacy',           color: '#5865f2' },
  { name: 'Gateway / Family', color: '#00bcd4' },
] as const;

export const DIFFICULTY_TAG_DEFINITIONS = [
  { name: 'Light',  color: '#95a5a6' },
  { name: 'Medium', color: '#f0b232' },
  { name: 'Heavy',  color: '#e74c3c' },
] as const;

export type GenreTagName = typeof GENRE_TAG_DEFINITIONS[number]['name'];
export type DifficultyTagName = typeof DIFFICULTY_TAG_DEFINITIONS[number]['name'];
