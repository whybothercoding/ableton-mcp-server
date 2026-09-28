import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { AbletonClient } from './client/AbletonClient.js';
import { TOOLS } from './tools/definitions.js';
import { ToolHandler } from './tools/handlers.js';

export class AbletonMcpServer {
  private server: Server;
  private client: AbletonClient;
  private handler: ToolHandler;

  constructor() {
    this.client = new AbletonClient();
    this.handler = new ToolHandler(this.client);

    this.server = new Server(
      {
        name: 'ableton-mcp-server',
        version: '1.0.0'
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema
        }))
      };
    });

    // Handle tool execution
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      return await this.handler.handleToolCall(name, args || {});
    });
  }

  public async start(): Promise<void> {
    // Attempt initial capabilities fetch in background without crashing server startup
    try {
      const info = await this.client.fetchCapabilities();
      console.error(
        `[AbletonMcpServer] Connected to Ableton Live Remote Script v${info.script_version} (${info.capabilities.length} capabilities loaded)`
      );
    } catch (err: any) {
      console.error(
        `[AbletonMcpServer] Initial connection attempt to Ableton Live Remote Script failed: ${err.message}. Server starting in disconnected mode.`
      );
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('[AbletonMcpServer] stdio MCP server running');
  }
}
