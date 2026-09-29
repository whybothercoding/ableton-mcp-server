import { TOOL_SPECS, ToolAnnotations } from './spec.js';

export interface ToolDefinition {
  name: string;
  description: string;
  annotations?: ToolAnnotations;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  requiredCapability?: string;
}

/** The two tools that are not declarative specs: a health ping and the gated Python escape hatch. */
const LEGACY_TOOLS: ToolDefinition[] = [
  {
    name: 'get_health',
    description: 'Ping Ableton Live Remote Script TCP bridge, report connection status, script version, and available capabilities.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'eval_python',
    description: 'Evaluate raw Python code on the Ableton Remote Script instance (for development and advanced debugging). Needs the opt-in file ~/.ableton-mcp-server/allow_eval as well as ABLETON_MCP_ALLOW_EVAL=1.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python expression or script to execute on self' }
      },
      required: ['code']
    },
    requiredCapability: 'eval'
  }
];

/** Tools that are hidden and refused unless the named environment variable is "1" in the MCP server's environment. */
export const GATED_TOOLS: Record<string, string> = {
  eval_python: 'ABLETON_MCP_ALLOW_EVAL',
  record: 'ABLETON_MCP_ALLOW_RECORD'
};

export function isToolEnabled(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const variable = GATED_TOOLS[name];
  return variable === undefined || env[variable] === '1';
}

/** Legacy tools (switch in handlers.ts) followed by the declarative specs (spec.ts). */
export const TOOLS: ToolDefinition[] = [
  ...LEGACY_TOOLS,
  ...TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    annotations: spec.annotations,
    requiredCapability: spec.bridge.command
  }))
];
