import type { CSSProperties } from 'react';
import { missingTitleCharacters } from '@tripweaver/shared';

const fallback: CSSProperties = { fontFamily: "'Noto Serif SC Variable', SimSun, serif" };

/** Keep unsupported letters in a single typeface; punctuation/emoji can use normal fallback. */
export function handwritingFallback(text: string): CSSProperties | undefined {
  return missingTitleCharacters([text]).some(character => /[\p{L}\p{N}]/u.test(character))
    ? fallback : undefined;
}
