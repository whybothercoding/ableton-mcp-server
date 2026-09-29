/** A minimal JSON-schema validator for tool arguments: required, types, enums, arrays and nested objects. */

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A batch reference such as $0.address or $2.ids[0]: it stands for a value a previous op returned. */
export const BATCH_REFERENCE = /^\$\d+(?:\.[A-Za-z_]\w*|\[\d+\])*$/;

function checkValue(schema: any, value: unknown, label: string, refs: boolean): string | null {
  if (schema === undefined || schema === null) return null;
  if (refs && typeof value === 'string' && BATCH_REFERENCE.test(value)) return null;
  const type = schema.type;
  const bad = (expected: string) => `${label} must be ${expected}`;
  if (type === 'number' && !(typeof value === 'number' && Number.isFinite(value))) return bad('a number');
  if (type === 'string' && typeof value !== 'string') return bad('a string');
  if (type === 'boolean' && typeof value !== 'boolean') return bad('true or false');
  if (type === 'object' && !isPlainObject(value)) return bad('an object');
  if (type === 'array') {
    if (!Array.isArray(value)) return bad('an array');
    for (let i = 0; i < value.length; i += 1) {
      const problem = checkValue(schema.items, value[i], `${label}[${i}]`, refs);
      if (problem) return problem;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${label} must be one of: ${schema.enum.join(', ')}`;
  if (type === 'object' && isPlainObject(value)) return checkObject(schema, value, label, refs);
  return null;
}

function checkObject(schema: any, value: Record<string, unknown>, label: string, refs: boolean): string | null {
  for (const key of schema.required ?? []) {
    if (value[key] === undefined || value[key] === null) return `${label ? label + ': ' : ''}missing required argument '${key}'`;
  }
  for (const [key, sub] of Object.entries<any>(schema.properties ?? {})) {
    if (value[key] === undefined || value[key] === null) continue;
    const problem = checkValue(sub, value[key], label ? `${label}.${key}` : key, refs);
    if (problem) return problem;
  }
  return null;
}

/** Validates tool arguments against the advertised JSON schema; returns a readable problem or null. With `refs`, batch references pass for any type. */
export function validateArgs(schema: { type: 'object'; properties: Record<string, any>; required?: string[] }, args: Record<string, unknown>, refs = false): string | null {
  return checkObject(schema, args, '', refs);
}

