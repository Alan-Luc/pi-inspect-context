import { extname } from 'node:path';
import { MAX_EXCERPT_LINES } from '../packet.ts';
import type { ClassifyCandidate, RetrievalFile, RetrievalWindow, SearchTerm } from './contracts.ts';

const maxExpandedEvidenceBodies = 3;
const declarationBodyPrefix = /^(?:(?:export|default|declare|abstract|async|public|private|protected|static|final)\s+)*(function|class|interface|enum|type)\s+/;
const arrowBodyPrefix = /^(?:export\s+)?(?:const|let|var)\s+[^=;]+\s*=\s*(?:async\s+)?(?:\([^;{}]*\)|[a-z_$][\w$]*)\s*(?::[^=;{}]+)?=>/;
const arrowHeaderStart = /^(?:export\s+)?(?:const|let|var)\s+[^=;]+\s*=\s*(?:async\s*)?\([^);{}]*$/;

type SourceBodyRange = { startLine: number; endLine: number; complete: boolean; found: boolean; enclosed: boolean };
type BodyLexState = { quote: string; blockComment: boolean; uncertain: boolean };

export const memberDefinitionPatterns: Readonly<Record<string, RegExp>> = {
  '.ts': /^(?:(?:public|private|protected|static|async|abstract|override|readonly|get|set)\s+)*([a-z_$][\w$]*)\s*(?:<[^{};]*>)?\([^;{}]*\)\s*(?::[^;{}=]+)?\s*\{/,
  '.go': /^func\s+\([^)]*\)\s+(\w+)\s*\(/,
  '.py': /^([a-z_]\w*)\s*:\s*[a-z_\[]/,
  '.java': /^(?:(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:[\w.$]+(?:<[^;{}]+>)?(?:\[\])?\s+)+([a-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:throws\s+[\w.,\s]+)?\s*\{/,
};

function minInt(left: number, right: number): number { return Math.min(left, right); }
function maxInt(left: number, right: number): number { return Math.max(left, right); }
function javascriptPath(extension: string): boolean { return ['.ts', '.tsx', '.js', '.jsx'].includes(extension); }

function bodyCodeLine(line: string, extension: string, state: BodyLexState): string {
  if ((extension !== '.go' && line.replace(/[\r\n]+$/, '').includes('\r')) || (javascriptPath(extension) && /[\u2028\u2029]/.test(line)) || (extension === '.java' && line.includes('\\u'))) state.uncertain = true;
  let code = '';
  for (let index = 0; index < line.length;) {
    const rest = line.slice(index);
    if (state.blockComment) {
      if (rest.startsWith('*/')) { state.blockComment = false; index += 2; } else index++;
      continue;
    }
    if (state.quote !== '') {
      if (javascriptPath(extension) && state.quote === '`' && rest.startsWith('${')) state.uncertain = true;
      if (line[index] === '\\' && !(extension === '.go' && state.quote === '`')) index += 2;
      else if (rest.startsWith(state.quote)) { index += state.quote.length; state.quote = ''; }
      else index++;
      continue;
    }
    if ((extension === '.py' && line[index] === '#') || (extension !== '.py' && rest.startsWith('//'))) break;
    if (extension !== '.py' && rest.startsWith('/*')) { state.blockComment = true; code += ' '; index += 2; continue; }
    const character = line[index];
    if (character === "'" || character === '"' || character === '`') {
      if (extension === '.py' && index > 0) {
        const prefix = line.slice(maxInt(0, index - 2), index).toLowerCase();
        if (['f', 'fr', 't', 'tr'].some((value) => prefix.endsWith(value))) state.uncertain = true;
      }
      state.quote = character;
      if ((extension === '.py' || extension === '.java') && rest.startsWith(character.repeat(3))) state.quote = character.repeat(3);
      code += 'x'; index += state.quote.length; continue;
    }
    if (javascriptPath(extension) && (character === '/' || character === '<' || (character === '>' && (index === 0 || line[index - 1] !== '=')))) state.uncertain = true;
    code += character; index++;
  }
  if (javascriptPath(extension) && (state.quote === "'" || state.quote === '"')) state.uncertain = true;
  return code;
}

function bodyHeader(line: string, extension: string): boolean {
  const trimmed = line.trim().toLowerCase();
  if (extension === '.py') return trimmed.startsWith('def ') || trimmed.startsWith('async def ') || trimmed.startsWith('class ');
  if (extension === '.go') return trimmed.startsWith('func ') || trimmed.startsWith('type ');
  if (javascriptPath(extension)) {
    if (declarationBodyPrefix.test(trimmed) || arrowBodyPrefix.test(trimmed) || arrowHeaderStart.test(trimmed)) return true;
    extension = '.ts';
  } else if (extension === '.java') {
    if (declarationBodyPrefix.test(trimmed)) return true;
  } else return false;
  const match = memberDefinitionPatterns[extension]?.exec(trimmed);
  if (!match || match.length < 2) return false;
  const words = [trimmed.split(/\s+/)[0], match[1]];
  return !words.some((word) => ['if', 'for', 'while', 'switch', 'catch', 'with', 'else', 'do', 'new', 'return', 'throw', 'yield', 'assert'].includes(word));
}

function sourceBody(file: RetrievalFile, startLine: number): SourceBodyRange {
  const extension = extname(file.path).toLowerCase();
  if (!bodyHeader(file.lines[startLine - 1], extension)) return { startLine: 0, endLine: 0, complete: false, found: false, enclosed: false };
  if (extension === '.py') return pythonBody(file, startLine);
  const result: SourceBodyRange = { startLine, endLine: minInt(file.lines.length, startLine + MAX_EXCERPT_LINES - 1), found: true, enclosed: false, complete: false };
  if (javascriptPath(extension)) {
    const declaration = declarationBodyPrefix.exec(file.lines[startLine - 1].trim().toLowerCase());
    if (declaration && declaration[1] !== 'function') return { ...result, found: false };
  }
  const state: BodyLexState = { quote: '', blockComment: false, uncertain: false };
  let header = '';
  let round = 0, square = 0, headerBraces = 0, bodyBraces = 0, parametersEnd = 0;
  for (let number = startLine; number <= result.endLine; number++) {
    const code = bodyCodeLine(file.lines[number - 1], extension, state);
    if (state.uncertain) { result.found = result.endLine === file.lines.length; return result; }
    for (const character of code) {
      if (bodyBraces > 0) {
        if (character === '{') bodyBraces++;
        else if (character === '}' && --bodyBraces === 0) {
          result.endLine = number; result.enclosed = true; result.complete = !state.uncertain && state.quote === '' && !state.blockComment; return result;
        }
        continue;
      }
      switch (character) {
        case '(': round++; break;
        case ')': round--; if (javascriptPath(extension) && round === 0 && parametersEnd === 0) parametersEnd = header.length + 1; break;
        case '[': square++; break;
        case ']': square--; break;
        case '{':
          if (round === 0 && square === 0 && headerBraces === 0 && bodyHeader(`${header}{`, extension)) {
            const prefix = header.toLowerCase();
            const returns = prefix.slice(prefix.lastIndexOf(')') + 1);
            if (extension === '.go' && prefix.trimStart().startsWith('func ') && (returns.includes('struct') || returns.includes('interface'))) return result;
            if (javascriptPath(extension)) {
              const ambiguousType = (parametersEnd > 0 && header.slice(parametersEnd).includes(':')) || (prefix.split('<').length > prefix.split('>').length);
              const ambiguousArrow = (prefix.match(/=>/g)?.length ?? 0) > 1 || (prefix.includes('=>') && (!arrowBodyPrefix.test(prefix) || !prefix.trimEnd().endsWith('=>')));
              if (ambiguousArrow || ambiguousType) { result.found = result.endLine === file.lines.length; return result; }
            }
            bodyBraces = 1;
          } else headerBraces++;
          break;
        case '}': headerBraces--; break;
        case ';':
          if (round === 0 && square === 0 && headerBraces === 0) {
            if (!arrowBodyPrefix.test(header.toLowerCase())) return { startLine: 0, endLine: 0, complete: false, found: false, enclosed: false };
            result.endLine = number; result.enclosed = true; result.complete = state.quote === '' && !state.blockComment && !state.uncertain; return result;
          }
      }
      header += character;
    }
    header += ' ';
  }
  return result;
}

function pythonIndent(line: string): number {
  let indent = 0;
  for (const character of line) {
    if (character === ' ') indent++;
    else if (character === '\t') indent = (Math.floor(indent / 8) + 1) * 8;
    else if (character === '\f') indent = 0;
    else break;
  }
  return indent;
}

function pythonBody(file: RetrievalFile, startLine: number): SourceBodyRange {
  const result: SourceBodyRange = { startLine, endLine: minInt(file.lines.length, startLine + MAX_EXCERPT_LINES - 1), found: true, enclosed: false, complete: false };
  const state: BodyLexState = { quote: '', blockComment: false, uncertain: false };
  const indent = pythonIndent(file.lines[startLine - 1]);
  let depth = 0, headerEnded = false, sawBody = false, continued = false;
  for (let number = startLine; number <= minInt(file.lines.length, result.endLine + 1); number++) {
    const continuation = state.quote !== '' || depth > 0 || continued;
    const line = file.lines[number - 1];
    const code = bodyCodeLine(line, '.py', state);
    if (state.uncertain) { result.found = result.endLine === file.lines.length; return result; }
    if (headerEnded && !continuation && code.trim() !== '' && pythonIndent(line) <= indent) {
      result.endLine = number - 1; result.enclosed = true; result.complete = sawBody && state.quote === '' && !state.uncertain; return result;
    }
    if (number > result.endLine) return result;
    continued = code.trimEnd().endsWith('\\');
    if (headerEnded && code.trim() !== '') sawBody = true;
    for (let index = 0; index < code.length; index++) {
      const character = code[index];
      if ('([{'.includes(character)) depth++;
      else if (')]}'.includes(character)) depth--;
      else if (character === ':' && !headerEnded && depth === 0) {
        headerEnded = true;
        if (code.slice(index + 1).trim() !== '') { sawBody = true; state.uncertain = true; }
      }
    }
  }
  result.enclosed = result.endLine === file.lines.length && headerEnded && sawBody && depth === 0 && !continued;
  result.complete = result.enclosed && state.quote === '' && !state.uncertain;
  return result;
}

export function prepareEvidenceWindow(file: RetrievalFile, window: RetrievalWindow, kind: import('../packet.ts').ExcerptKind, terms: SearchTerm[], expandedBodies: { count: number }, classifyCandidate: ClassifyCandidate): RetrievalWindow {
  const firstCandidate = window.candidates[0];
  if (!firstCandidate) return window;
  let first = firstCandidate.startLine, last = firstCandidate.endLine, anchor = first;
  for (const candidate of window.candidates) {
    first = minInt(first, candidate.startLine); last = maxInt(last, candidate.endLine);
    for (const category of classifyCandidate(candidate.path, file.lines[candidate.startLine - 1], candidate, terms)) if (category.kind === kind) anchor = candidate.startLine;
  }
  let radius = 0;
  switch (kind) {
    case 'governing': return window;
    case 'definition': case 'caller': radius = 2; break;
    case 'test': case 'configuration': radius = 1; break;
  }
  window.startLine = maxInt(1, first - radius); window.endLine = minInt(file.lines.length, last + radius);
  if (window.endLine - window.startLine + 1 > MAX_EXCERPT_LINES) {
    window.endLine = maxInt(last, window.startLine + MAX_EXCERPT_LINES - 1);
    window.startLine = maxInt(1, window.endLine - MAX_EXCERPT_LINES + 1);
  }
  if ((kind !== 'definition' && kind !== 'caller') || expandedBodies.count >= maxExpandedEvidenceBodies) return window;
  for (let start = anchor; start >= maxInt(1, anchor - MAX_EXCERPT_LINES + 1); start--) {
    const body = sourceBody(file, start);
    if (body.found && (kind !== 'caller' || (body.enclosed && body.endLine >= last))) {
      const begin = minInt(body.startLine, first), end = maxInt(body.endLine, last);
      if (end - begin + 1 <= MAX_EXCERPT_LINES) {
        window.startLine = begin; window.endLine = end;
        window.bodyComplete = body.complete && begin === body.startLine && end === body.endLine;
        expandedBodies.count++;
        return window;
      }
    }
    if (kind === 'definition') break;
  }
  return window;
}
