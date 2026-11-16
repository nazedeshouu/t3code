import { scoreQueryMatch } from "./searchRanking.ts";

/** Scores sit in bands this wide: exact, prefix, word start, substring, then subsequence. */
const TIER_WIDTH = 1000;

/** `scoreEntryName` scores from here up matched as scattered letters rather than one run. */
export const SUBSEQUENCE_MATCH_SCORE = 4 * TIER_WIDTH;

/**
 * How closely a file or folder name matches typed text: lower is closer, null is no match. The
 * thousands digit is the match tier.
 */
export function scoreEntryName(name: string, query: string): number | null {
  // macOS Finder stores names decomposed (NFD), while typed text is composed (NFC).
  const options = {
    // Position penalties stay under 1000 for 255-character names, so tiers never overlap.
    query: query.normalize("NFC").toLowerCase(),
    exactBase: 0,
    prefixBase: TIER_WIDTH,
    boundaryBase: 2 * TIER_WIDTH,
    includesBase: 3 * TIER_WIDTH,
    fuzzyBase: SUBSEQUENCE_MATCH_SCORE,
    boundaryMarkers: [" ", "-", "_", "."],
  };
  const rawScore = scoreQueryMatch({
    ...options,
    value: name.toLowerCase(),
    query: query.toLowerCase(),
  });
  const normalizedScore = scoreQueryMatch({
    ...options,
    value: name.normalize("NFC").toLowerCase(),
  });
  if (rawScore === null) return normalizedScore;
  return normalizedScore === null ? rawScore : Math.min(rawScore, normalizedScore);
}

const byName = new Intl.Collator(undefined, { numeric: true });

/**
 * A directory's entries for the name fragment typed in an `@` path: closest tier first, then A
 * to Z. Dotfiles match only a fragment starting with a dot, and such a fragment matches nothing
 * else. Client and server both rank with this, so a folder's size never changes what matches.
 */
export function rankPathEntries<Entry extends { readonly name: string }>(
  entries: ReadonlyArray<Entry>,
  fragment: string,
): Array<Entry> {
  const wantsDotfiles = fragment.startsWith(".");
  const ranked: Array<{ readonly entry: Entry; readonly tier: number }> = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") !== wantsDotfiles) continue;
    const score = fragment.length === 0 ? 0 : scoreEntryName(entry.name, fragment);
    if (score !== null) ranked.push({ entry, tier: Math.floor(score / TIER_WIDTH) });
  }
  return ranked
    .sort(
      (left, right) => left.tier - right.tier || byName.compare(left.entry.name, right.entry.name),
    )
    .map((match) => match.entry);
}
