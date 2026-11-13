export const MAX_WORKER_INPUT_BYTES = 64 * 1024;

type JSONContainer = { keys?: Set<string>; expectsKey: boolean };

export function decodeWorkerJSON(input: Buffer): unknown {
  if (input.byteLength > MAX_WORKER_INPUT_BYTES) throw new RangeError(`worker JSON exceeds ${MAX_WORKER_INPUT_BYTES} bytes`);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input); }
  catch { throw new SyntaxError('worker JSON must be valid UTF-8'); }
  const value: unknown = JSON.parse(text);
  const containers: JSONContainer[] = [];
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      const start = index;
      for (index++; index < text.length; index++) {
        if (text[index] === '\\') index++;
        else if (text[index] === '"') break;
      }
      const container = containers.at(-1);
      if (container?.keys && container.expectsKey) {
        const key: unknown = JSON.parse(text.slice(start, index + 1));
        if (typeof key !== 'string') throw new SyntaxError('JSON object key must be a string');
        if (container.keys.has(key)) throw new SyntaxError(`duplicate object key ${JSON.stringify(key)}`);
        container.keys.add(key);
        container.expectsKey = false;
      }
    } else if (character === '{') containers.push({ keys: new Set(), expectsKey: true });
    else if (character === '[') containers.push({ expectsKey: false });
    else if (character === '}' || character === ']') containers.pop();
    else if (character === ',') {
      const container = containers.at(-1);
      if (container?.keys) container.expectsKey = true;
    }
  }
  return value;
}
