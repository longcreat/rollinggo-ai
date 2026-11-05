import { handwritingCharacters } from './handwriting.generated';

const supported = new Set(handwritingCharacters);

/** Check actual shipped glyph coverage by Unicode code point. */
export function missingTitleCharacters(titles: readonly string[]): string[] {
  return [...new Set(titles.flatMap((title) => Array.from(title.trim())))]
    .filter((character) => !supported.has(character));
}
