/**
 * Declarative tool specs: a tool's schema, MCP annotations and bridge mapping live in one place.
 * Legacy tools are still handled by the switch in handlers.ts and migrate here as their replacements land.
 */

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, any>; required?: string[] };
  annotations: ToolAnnotations;
  bridge: {
    /** Remote Script command; also the capability the connected script must advertise. */
    command: string;
    /** Maps tool arguments to bridge params. Defaults to passing the arguments through unchanged. */
    params?: (args: Record<string, any>) => Record<string, any>;
  };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkValue(schema: any, value: unknown, label: string): string | null {
  if (schema === undefined || schema === null) return null;
  const type = schema.type;
  const bad = (expected: string) => `${label} must be ${expected}`;
  if (type === 'number' && !(typeof value === 'number' && Number.isFinite(value))) return bad('a number');
  if (type === 'string' && typeof value !== 'string') return bad('a string');
  if (type === 'boolean' && typeof value !== 'boolean') return bad('true or false');
  if (type === 'object' && !isPlainObject(value)) return bad('an object');
  if (type === 'array') {
    if (!Array.isArray(value)) return bad('an array');
    for (let i = 0; i < value.length; i += 1) {
      const problem = checkValue(schema.items, value[i], `${label}[${i}]`);
      if (problem) return problem;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${label} must be one of: ${schema.enum.join(', ')}`;
  if (type === 'object' && isPlainObject(value)) return checkObject(schema, value, label);
  return null;
}

function checkObject(schema: any, value: Record<string, unknown>, label: string): string | null {
  for (const key of schema.required ?? []) {
    if (value[key] === undefined || value[key] === null) return `${label ? label + ': ' : ''}missing required argument '${key}'`;
  }
  for (const [key, sub] of Object.entries<any>(schema.properties ?? {})) {
    if (value[key] === undefined || value[key] === null) continue;
    const problem = checkValue(sub, value[key], label ? `${label}.${key}` : key);
    if (problem) return problem;
  }
  return null;
}

/** Validates tool arguments against the advertised JSON schema; returns a readable problem or null. */
export function validateArgs(schema: ToolSpec['inputSchema'], args: Record<string, unknown>): string | null {
  return checkObject(schema, args, '');
}

const ADDRESS_HELP =
  "Addresses: 'song', 'master', 'tracks/N', 'returns/N', 'scenes/N', 'tracks/N/slots/M' (clip slot) and " +
  "'tracks/N/slots/M/clip'. Indices are 0-based. A name selector works anywhere a number does, e.g. 'tracks/name:Drift' " +
  '(exact match; several matches is an error that lists their indices).';

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'get_properties',
    description:
      'Read properties of a Song, Track, Scene, ClipSlot or Clip. ' + ADDRESS_HELP +
      ' Give `names` for specific properties, or omit it to read every readable property (properties that do not apply to the ' +
      'object, e.g. audio-only ones on a MIDI clip, are listed under `unavailable`). Enum values come back as names. ' +
      'Use list_properties to see what exists.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: "Object address, e.g. 'tracks/0/slots/1/clip'" },
        names: { type: 'array', items: { type: 'string' }, description: 'Property names to read (default: all)' }
      },
      required: ['address']
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    bridge: { command: 'get_properties' }
  },
  {
    name: 'set_properties',
    description:
      'Set properties on a Song, Track, Scene, ClipSlot or Clip. ' + ADDRESS_HELP +
      ' Values are checked strictly (booleans must be true/false, integers whole numbers, enums given by name; see list_properties). ' +
      'Interdependent properties (e.g. loop_start/loop_end) can be set together in any order, and the call is all-or-nothing: if one ' +
      'write fails, the others are restored. Returns each property\'s previous and new value. Each call is one undo step in Live. ' +
      'Give `address` + `properties`, or `items` to change several objects in one call. `expect` ({name}) refuses to write if the object is not the one you meant.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Object address' },
        properties: { type: 'object', description: "Property values, e.g. {\"mute\": true, \"volume\": 0.7}" },
        expect: { type: 'object', description: "Guard: {\"name\": \"Drift\"} (optionally class_name) must match the object, or nothing is written" },
        items: {
          type: 'array',
          description: 'Several objects at once: [{address, properties, expect?}]',
          items: {
            type: 'object',
            properties: { address: { type: 'string' }, properties: { type: 'object' }, expect: { type: 'object' } },
            required: ['address', 'properties']
          }
        }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    bridge: { command: 'set_properties' }
  },
  {
    name: 'list_properties',
    description:
      'List the properties get_properties/set_properties know for an object kind: type, whether it is writable, allowed enum values ' +
      'and ranges. Give an `address` (its kind is used) or a `kind`: song, track, scene, slot or clip.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Object address; its kind is listed' },
        kind: { type: 'string', enum: ['song', 'track', 'scene', 'slot', 'clip'], description: 'Object kind (when no address is given)' }
      }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    bridge: { command: 'list_properties' }
  }
];

export const TOOL_SPEC_BY_NAME: Record<string, ToolSpec> = Object.fromEntries(TOOL_SPECS.map((s) => [s.name, s]));
