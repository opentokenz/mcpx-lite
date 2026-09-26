export class McpTrustStore {
  private readonly trustedConnections = new Set<string>();
  private readonly trustedCalls = new Set<string>();

  isTrusted(sessionId: string, configHash: string): boolean {
    return this.trustedConnections.has(connectionKey(sessionId, configHash));
  }

  trust(sessionId: string, configHash: string): void {
    this.trustedConnections.add(connectionKey(sessionId, configHash));
  }

  isCallsTrusted(sessionId: string, serverName: string, configHash: string): boolean {
    return this.trustedCalls.has(callKey(sessionId, serverName, configHash));
  }

  trustCalls(sessionId: string, serverName: string, configHash: string): void {
    this.trustedCalls.add(callKey(sessionId, serverName, configHash));
  }

  clearSession(sessionId: string): void {
    const prefix = sessionId + '\0';
    for (const value of this.trustedConnections) {
      if (value.startsWith(prefix)) this.trustedConnections.delete(value);
    }
    for (const value of this.trustedCalls) {
      if (value.startsWith(prefix)) this.trustedCalls.delete(value);
    }
  }
}

function connectionKey(sessionId: string, configHash: string): string {
  return sessionId + '\0' + configHash;
}

function callKey(sessionId: string, serverName: string, configHash: string): string {
  return sessionId + '\0' + serverName + '\0' + configHash;
}
