import { describe, expect, it } from 'vitest';
import { createShutdownHandler } from '../src/index.js';

describe('mcpx-lite runtime shutdown', () => {
  it('先关闭 downstream MCP manager，再关闭 HTTP server，最后退出', async () => {
    const events: string[] = [];
    const shutdown = createShutdownHandler({
      logger: {
        event: (name: string) => {
          events.push('log:' + name);
        },
      },
      manager: {
        closeAll: async () => {
          events.push('mcp-close');
        },
      },
      server: {
        close: (done: () => void) => {
          events.push('server-close');
          done();
        },
      },
      exit: (code: number) => {
        events.push('exit:' + code);
      },
    });

    await shutdown('SIGTERM');

    expect(events).toEqual([
      'log:shutdown',
      'mcp-close',
      'server-close',
      'exit:0',
    ]);
  });
});
