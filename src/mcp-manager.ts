import type { ResolvedMcpServer } from './mcp-config.js';

export interface ManagedMcpConnection {
  close(): Promise<void>;
}

export type McpConnectionState = 'disconnected' | 'connecting' | 'connected' | 'failed';

export interface McpConnectionStatus {
  state: McpConnectionState;
  error?: string;
}

interface ConnectionEntry<C extends ManagedMcpConnection> {
  server: ResolvedMcpServer;
  state: Exclude<McpConnectionState, 'disconnected'>;
  connection?: C;
  pending?: Promise<C>;
  error?: string;
}

export class McpManager<C extends ManagedMcpConnection = ManagedMcpConnection> {
  private readonly connect: (server: ResolvedMcpServer) => Promise<C>;
  private readonly sanitizeError: (error: unknown) => string;
  private readonly entries = new Map<string, ConnectionEntry<C>>();
  private readonly scopeRefs = new Map<string, Set<string>>();

  constructor(opts: {
    connect: (server: ResolvedMcpServer) => Promise<C>;
    sanitizeError?: (error: unknown) => string;
  }) {
    this.connect = opts.connect;
    this.sanitizeError = opts.sanitizeError ?? defaultErrorMessage;
  }

  async get(scopeId: string, server: ResolvedMcpServer): Promise<C> {
    const key = connectionKey(server);
    this.addScopeRef(scopeId, key);

    const existing = this.entries.get(key);
    if (existing?.connection) return existing.connection;
    if (existing?.pending) return existing.pending;
    if (existing?.state === 'failed') {
      throw new Error(existing.error ?? `failed to connect MCP server ${server.name}`);
    }

    const entry: ConnectionEntry<C> = { server, state: 'connecting' };
    const pending = this.connect(server)
      .then((connection) => {
        entry.connection = connection;
        entry.state = 'connected';
        entry.pending = undefined;
        return connection;
      })
      .catch((error: unknown) => {
        entry.state = 'failed';
        entry.pending = undefined;
        entry.error = this.sanitizeError(error);
        throw error;
      });

    entry.pending = pending;
    this.entries.set(key, entry);
    return pending;
  }

  status(server: ResolvedMcpServer): McpConnectionStatus {
    const entry = this.entries.get(connectionKey(server));
    if (!entry) return { state: 'disconnected' };
    if (entry.state === 'failed') {
      return { state: 'failed', ...(entry.error ? { error: entry.error } : {}) };
    }
    return { state: entry.state };
  }

  async reload(scopeId: string, activeServers: ResolvedMcpServer[]): Promise<void> {
    const activeKeys = new Set(activeServers.map(connectionKey));
    const refs = this.scopeRefs.get(scopeId);
    if (!refs) return;

    const removed: string[] = [];
    for (const key of refs) {
      if (activeKeys.has(key)) continue;
      refs.delete(key);
      removed.push(key);
    }
    if (refs.size === 0) this.scopeRefs.delete(scopeId);

    for (const key of removed) {
      if (!this.isReferenced(key)) await this.closeEntry(key);
    }
  }

  async closeScope(scopeId: string): Promise<void> {
    const refs = this.scopeRefs.get(scopeId);
    if (!refs) return;
    this.scopeRefs.delete(scopeId);

    for (const key of refs) {
      if (!this.isReferenced(key)) await this.closeEntry(key);
    }
  }

  async closeAll(): Promise<void> {
    this.scopeRefs.clear();
    const keys = [...this.entries.keys()];
    for (const key of keys) await this.closeEntry(key);
  }

  private addScopeRef(scopeId: string, key: string): void {
    let refs = this.scopeRefs.get(scopeId);
    if (!refs) {
      refs = new Set();
      this.scopeRefs.set(scopeId, refs);
    }
    refs.add(key);
  }

  private isReferenced(key: string): boolean {
    for (const refs of this.scopeRefs.values()) {
      if (refs.has(key)) return true;
    }
    return false;
  }

  private async closeEntry(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);

    if (entry.connection) {
      await entry.connection.close();
      return;
    }

    if (entry.pending) {
      try {
        const connection = await entry.pending;
        await connection.close();
      } catch {
        // Failed connections have nothing left to close.
      }
    }
  }
}

function connectionKey(server: ResolvedMcpServer): string {
  return `${server.name}\0${server.hash}`;
}

function defaultErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
