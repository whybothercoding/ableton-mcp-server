import * as net from 'net';
import {
  ScriptInfo,
  RemoteScriptResponse,
  RemoteScriptCommand
} from '../types/ableton.js';

export interface AbletonClientOptions {
  host?: string;
  port?: number;
  timeoutMs?: number;
}

export class AbletonClientError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    /** True when the failure happened before the command was sent, so retrying cannot repeat it. */
    public readonly retryable: boolean = false,
    /** The Remote Script's error code (OUT_OF_RANGE, NOT_FOUND, TYPE_ERROR, ...) for REMOTE_ERROR failures. */
    public readonly bridgeCode?: string
  ) {
    super(message);
    this.name = 'AbletonClientError';
  }
}

const CONNECT_ATTEMPTS = 4;

export class AbletonClient {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private scriptInfo: ScriptInfo | null = null;
  private capabilitiesSet: Set<string> = new Set();

  constructor(options: AbletonClientOptions = {}) {
    this.host = options.host || process.env.ABLETON_HOST || '127.0.0.1';
    this.port = options.port || Number(process.env.ABLETON_PORT) || 9877;
    this.timeoutMs = options.timeoutMs || 10000;
  }

  /**
   * Execute a command on the Ableton Remote Script TCP bridge. Connection failures that happen
   * before anything is sent (e.g. a burst overflowing Live's listen backlog) are retried briefly.
   */
  public async sendCommand<T = any>(
    type: string,
    params: Record<string, any> = {}
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.sendOnce<T>(type, params);
      } catch (err) {
        if (!(err instanceof AbletonClientError) || !err.retryable || attempt >= CONNECT_ATTEMPTS) throw err;
        await new Promise((resolve) => setTimeout(resolve, 15 * attempt + Math.random() * 15));
      }
    }
  }

  private sendOnce<T>(type: string, params: Record<string, any>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let client: net.Socket | null = null;
      let connected = false;
      let buffer = '';
      let timer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (client) {
          client.removeAllListeners();
          client.destroy();
          client = null;
        }
      };

      timer = setTimeout(() => {
        cleanup();
        reject(
          new AbletonClientError(
            `Timeout waiting for response to command '${type}' after ${this.timeoutMs}ms`,
            'TIMEOUT'
          )
        );
      }, this.timeoutMs);

      try {
        client = net.createConnection(
          { host: this.host, port: this.port },
          () => {
            connected = true;
            const commandPayload: RemoteScriptCommand = { type, params };
            client?.write(JSON.stringify(commandPayload));
          }
        );

        client.on('data', (data: Buffer) => {
          buffer += data.toString('utf-8');
          try {
            const response: RemoteScriptResponse<T> = JSON.parse(buffer);
            cleanup();
            if (response.status === 'success') {
              resolve(response.result as T);
            } else {
              reject(
                new AbletonClientError(
                  response.message || `Command '${type}' failed on Live Remote Script`,
                  'REMOTE_ERROR',
                  false,
                  response.code
                )
              );
            }
          } catch {
            // Buffer may be incomplete, wait for more chunks
          }
        });

        client.on('error', (err: Error) => {
          cleanup();
          reject(
            new AbletonClientError(
              `Failed to connect to Ableton Live Remote Script at ${this.host}:${this.port}: ${err.message}`,
              'CONNECTION_ERROR',
              !connected
            )
          );
        });

        client.on('close', () => {
          if (buffer.length > 0) {
            try {
              const response: RemoteScriptResponse<T> = JSON.parse(buffer);
              cleanup();
              if (response.status === 'success') {
                resolve(response.result as T);
              } else {
                reject(
                  new AbletonClientError(
                    response.message || `Command '${type}' failed`,
                    'REMOTE_ERROR',
                    false,
                    response.code
                  )
                );
              }
              return;
            } catch {
              // invalid json at close
            }
          }
          cleanup();
        });
      } catch (err: any) {
        cleanup();
        reject(
          new AbletonClientError(
            `Failed to initiate socket connection: ${err.message}`,
            'SOCKET_ERROR'
          )
        );
      }
    });
  }

  /**
   * Refresh and query capabilities handshake from Live Remote Script
   */
  public async fetchCapabilities(): Promise<ScriptInfo> {
    try {
      const info = await this.sendCommand<ScriptInfo>('get_script_info');
      this.scriptInfo = info;
      this.capabilitiesSet = new Set(info.capabilities || []);
      return info;
    } catch (err: any) {
      console.error(`[AbletonClient] Failed capability discovery: ${err.message}`);
      throw err;
    }
  }

  /**
   * Check if a specific capability is supported by the connected script
   */
  public hasCapability(capability: string): boolean {
    if (this.capabilitiesSet.size === 0) {
      return true; // Default to trying if handshake hasn't run yet
    }
    return this.capabilitiesSet.has(capability);
  }

  /**
   * Ensure capability exists or throw informative error
   */
  public ensureCapability(capability: string): void {
    if (this.capabilitiesSet.size > 0 && !this.capabilitiesSet.has(capability)) {
      throw new AbletonClientError(
        `Capability '${capability}' is not supported by the connected Ableton Live Remote Script (version ${this.scriptInfo?.script_version || 'unknown'}).`,
        'UNSUPPORTED_CAPABILITY'
      );
    }
  }

  public getScriptVersion(): string | null {
    return this.scriptInfo?.script_version || null;
  }

  public getCapabilities(): string[] {
    return Array.from(this.capabilitiesSet);
  }
}
