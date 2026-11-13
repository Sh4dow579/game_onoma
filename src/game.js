// Καθαρή λογική παιχνιδιού (χωρίς δίκτυο) ώστε να ελέγχεται εύκολα.

export const LETTERS = ['Α', 'Β', 'Γ', 'Δ', 'Ε', 'Ζ', 'Η', 'Θ', 'Ι', 'Κ', 'Λ', 'Μ',
  'Ν', 'Ξ', 'Ο', 'Π', 'Ρ', 'Σ', 'Τ', 'Υ', 'Φ', 'Χ', 'Ψ', 'Ω'];

export const CATEGORIES = [
  { id: 'name', label: 'Όνομα' },
  { id: 'animal', label: 'Ζώο' },
  { id: 'plant', label: 'Φυτό' },
  { id: 'thing', label: 'Πράγμα' },
  { id: 'country', label: 'Χώρα' },
  { id: 'job', label: 'Επάγγελμα' },
  { id: 'food', label: 'Φαγητό' },
];
export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);
export const DEFAULT_CATEGORIES = ['name', 'animal', 'plant', 'thing'];

// Κανονικοποίηση: πεζά, χωρίς τόνους/διαλυτικά, τελικό σίγμα -> σ, ενιαία κενά.
export function normalize(text) {
  if (typeof text !== 'string') return '';
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLocaleLowerCase('el')
    .replace(/ς/g, 'σ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Έγκυρη απάντηση = μη κενή και ξεκινά από το γράμμα του γύρου.
export function isValid(answer, letter) {
  const n = normalize(answer);
  return n.length > 0 && n.startsWith(normalize(letter));
}

/**
 * Υπολογίζει πόντους ενός γύρου.
 * @param {string[]} playerIds  παίκτες που συμμετείχαν στον γύρο
 * @param {Object<string,Object<string,string>>} answers  answers[pid][catId]
 * @param {string[]} categories
 * @param {string} letter
 * @returns {{ perAnswer: Object, totals: Object<string,number> }}
 *   perAnswer[pid][catId] = { text, points, status }
 *   status: 'empty' | 'invalid' | 'unique' | 'shared'
 */
export function scoreRound(playerIds, answers, categories, letter) {
  const perAnswer = {};
  const totals = {};
  for (const pid of playerIds) { perAnswer[pid] = {}; totals[pid] = 0; }

  for (const cat of categories) {
    const norm = {};
    const valid = {};
    const counts = new Map();
    for (const pid of playerIds) {
      const raw = (answers[pid] && answers[pid][cat]) || '';
      norm[pid] = normalize(raw);
      valid[pid] = isValid(raw, letter);
      if (valid[pid]) counts.set(norm[pid], (counts.get(norm[pid]) || 0) + 1);
    }

    for (const pid of playerIds) {
      const text = ((answers[pid] && answers[pid][cat]) || '').trim();
      let points = 0;
      let status;
      if (!valid[pid]) {
        status = norm[pid] ? 'invalid' : 'empty';
      } else {
        const othersBlank = playerIds.some((q) => q !== pid && !valid[q]);
        const unique = counts.get(norm[pid]) === 1;
        status = unique ? 'unique' : 'shared';
        if (unique) points = othersBlank ? 20 : 10;
        else points = othersBlank ? 10 : 5;
      }
      perAnswer[pid][cat] = { text, points, status };
      totals[pid] += points;
    }
  }
  return { perAnswer, totals };
}

export function pickLetter(used) {
  const remaining = LETTERS.filter((l) => !used.includes(l));
  if (remaining.length === 0) return null;
  return remaining[Math.floor(Math.random() * remaining.length)];
}

