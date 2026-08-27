// These are direct imports of the canonical backend templates. esbuild bundles
// them as text; no independently maintained browser prompt strings exist.
import sentenceGeneric from '../templates/prompts/SentenceGeneric20260130.jinja2';
import sentenceJapanese from '../templates/prompts/SentenceJapanese20240628.jinja2';
import sentenceJapaneseLong20241002 from '../templates/prompts/SentenceJapaneseLong20241002.jinja2';
import sentenceJapaneseLong20250424 from '../templates/prompts/SentenceJapaneseLong20250424.jinja2';
import sentenceJapaneseLong20250603 from '../templates/prompts/SentenceJapaneseLong20250603.jinja2';
import sentenceJapaneseLong20251205 from '../templates/prompts/SentenceJapaneseLong20251205.jinja2';
import sentenceMandarin from '../templates/prompts/SentenceMandarin20250616.jinja2';
import wordGeneric from '../templates/prompts/WordGeneric20240628.jinja2';
import wordJapanese from '../templates/prompts/WordJapanese20250623.jinja2';
import wordMandarin from '../templates/prompts/WordMandarin20250616.jinja2';

export const PROMPT_TEMPLATES = {
  SentenceGeneric20260130: sentenceGeneric,
  SentenceJapanese20240628: sentenceJapanese,
  SentenceJapaneseLong20241002: sentenceJapaneseLong20241002,
  SentenceJapaneseLong20250424: sentenceJapaneseLong20250424,
  SentenceJapaneseLong20250603: sentenceJapaneseLong20250603,
  SentenceJapaneseLong20251205: sentenceJapaneseLong20251205,
  SentenceMandarin20250616: sentenceMandarin,
  WordGeneric20240628: wordGeneric,
  WordJapanese20250623: wordJapanese,
  WordMandarin20250616: wordMandarin,
} as const;

export const PROMPT_IDS = Object.freeze(Object.keys(PROMPT_TEMPLATES));
