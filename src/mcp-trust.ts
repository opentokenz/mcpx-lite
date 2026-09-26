export class McpTrustStore {
  private readonly trusted = new Set<string>();

  isTrusted(sessionId: string, configHash: string): boolean {
    return this.trusted.has(key(sessionId, configHash));
  }

  trust(sessionId: string, configHash: string): void {
    this.trusted.add(key(sessionId, configHash));
  }

  clearSession(sessionId: string): void {
    const prefix = sessionId + '\0';
    for (const value of this.trusted) {
      if (value.startsWith(prefix)) this.trusted.delete(value);
    }
  }
}

function key(sessionId: string, configHash: string): string {
  return sessionId + '\0' + configHash;
}
