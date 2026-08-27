import {PROMPT_IDS, PROMPT_TEMPLATES} from './prompt-templates.js';

export type PromptVariables = Record<string, string>;

/** Renders the checked-in Jinja subset: variables and nested if/else blocks. */
export function renderPrompt(promptId: string, variables: PromptVariables) {
  const template = (PROMPT_TEMPLATES as Readonly<Record<string, string>>)[
    promptId
  ];
  if (template === undefined) throw new Error(`Unknown prompt ID: ${promptId}`);
  // Match macro.py's `trim_blocks=True, lstrip_blocks=True` environment.
  const source = template
    .replace(/^[ \t]+(?={%)/gm, '')
    .replace(/%}\r?\n/g, '%}')
    .replace(/\r?\n$/, '');
  const token =
    /({%\s*(?:if\s+[A-Za-z][A-Za-z0-9_]*|else|endif)\s*%}|{{\s*[A-Za-z][A-Za-z0-9_]*\s*}})/g;
  if (source.replace(token, '').match(/{[{%]|[}%]}/)) {
    throw new Error(`Unsupported Jinja syntax in prompt: ${promptId}`);
  }
  const render = (
    start: number,
    stopAtControl: boolean,
  ): [string, number, 'else' | 'endif' | null] => {
    let output = '';
    let cursor = start;
    token.lastIndex = start;
    for (let match = token.exec(source); match; match = token.exec(source)) {
      output += source.slice(cursor, match.index);
      cursor = token.lastIndex;
      if (/^{{/.test(match[0])) {
        const key = match[0].match(/[A-Za-z][A-Za-z0-9_]*/)![0];
        if (!(key in variables))
          throw new Error(`Unknown prompt variable: ${key}`);
        output += variables[key];
      } else if (/else|endif/.test(match[0])) {
        if (!stopAtControl) throw new Error('Unexpected prompt control block');
        return [output, cursor, /else/.test(match[0]) ? 'else' : 'endif'];
      } else {
        const key = match[0].match(/if\s+([A-Za-z][A-Za-z0-9_]*)/)![1];
        if (!(key in variables))
          throw new Error(`Unknown prompt variable: ${key}`);
        const [trueBody, afterTrue, control] = render(cursor, true);
        let falseBody = '';
        let end = afterTrue;
        if (control === 'else') {
          let endControl: 'else' | 'endif' | null;
          [falseBody, end, endControl] = render(afterTrue, true);
          if (endControl !== 'endif') {
            throw new Error('Prompt else block must end with endif');
          }
        }
        output += variables[key] ? trueBody : falseBody;
        cursor = end;
        token.lastIndex = end;
      }
    }
    if (stopAtControl) throw new Error('Unclosed prompt if block');
    return [output + source.slice(cursor), cursor, null];
  };
  return render(0, false)[0];
}

/** Used by parity verification so newly bundled templates cannot be skipped. */
export function getPromptIds(): readonly string[] {
  return PROMPT_IDS;
}
