import { appendFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  StdioClientTransport,
  getDefaultEnvironment,
  type StdioServerParameters,
} from '@modelcontextprotocol/client/stdio';
import { isInputRequiredResult } from '@modelcontextprotocol/server';
import { createMcpConnection, type McpClientAdapter, type McpClientFactory } from '../src/mcp-client.js';
import type { ResolvedMcpServer } from '../src/mcp-config.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures', 'downstream-mcp.mjs');

// The SDK probes subclasses in place, keeping stderr available instead of discarding a sibling's stderr.
class DiagnosticStdioClientTransport extends StdioClientTransport {}

describe('真实 downstream MCP stdio', () => {
  it.skipIf(process.platform !== 'win32')('启动含空格路径的 .cmd，并保留含空格与元字符的独立参数', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mini pi mcp-'));
    const command = join(root, 'mcp server.cmd');
    const diagnosticsPath = join(root, 'stdio-diagnostics.log');
    const startMarker = join(root, 'fixture-started.marker');
    const argument = 'argument with spaces & ampersand';
    await writeFile(
      command,
      `@echo off\r\necho cmd-start>>"${diagnosticsPath}"\r\nset "MCPX_STDIO_DIAGNOSTICS_FILE=${diagnosticsPath}"\r\nset "FIXTURE_START_MARKER=${startMarker}"\r\n"${process.execPath}" "${fixture}" %*\r\n`,
      'utf8',
    );

    const server: ResolvedMcpServer = {
      name: 'cmd-fixture',
      source: 'global',
      transport: 'stdio',
      command,
      args: [argument],
      env: {},
      display: { command, args: [argument], env: [] },
      hash: 'fixture-stdio-cmd',
    };

    const diagnosticFactory: McpClientFactory = {
      getDefaultEnvironment,
      createClient(info, options) {
        return new Client(info, options) as unknown as McpClientAdapter;
      },
      createStdioTransport(options) {
        const transport = new DiagnosticStdioClientTransport(options as StdioServerParameters);
        transport.stderr?.on('data', (chunk: Buffer) => appendFileSync(diagnosticsPath, `powershell-stderr: ${chunk.toString('utf8')}\n`));
        return transport;
      },
      createHttpTransport(url, options) {
        return new StreamableHTTPClientTransport(url, options);
      },
    };
    const diagnosticTimer = setTimeout(() => {
      void readFile(diagnosticsPath, 'utf8')
        .then((diagnostics) => console.error(`[Windows .cmd stdio diagnostic]\n${diagnostics}`))
        .catch(() => console.error('[Windows .cmd stdio diagnostic] <no launch marker or stderr>'));
    }, 8_000);

    try {
      const connection = await createMcpConnection(server, diagnosticFactory);
      clearTimeout(diagnosticTimer);
      try {
        expect(connection.info().serverInfo).toEqual({ name: argument, version: '1.0.0' });
      } finally {
        await connection.close();
      }
    } catch (error) {
      const diagnostics = await readFile(diagnosticsPath, 'utf8').catch(() => '<no launch marker or stderr>');
      console.error(`[Windows .cmd stdio diagnostic]\n${diagnostics}`);
      throw error;
    } finally {
      clearTimeout(diagnosticTimer);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('把 stdio 参数原样作为独立 argv 传给 server', async () => {
    const server: ResolvedMcpServer = {
      name: 'argv-fixture',
      source: 'global',
      transport: 'stdio',
      command: process.execPath,
      args: [fixture, 'argument with spaces', 'second-argument'],
      env: {},
      display: { command: process.execPath, args: [fixture, 'argument with spaces', 'second-argument'], env: [] },
      hash: 'fixture-stdio-argv',
    };

    const connection = await createMcpConnection(server);
    try {
      expect(connection.info().serverInfo).toEqual({ name: 'argument with spaces', version: '1.0.0' });
    } finally {
      await connection.close();
    }
  });

  it('连接后可 inspect tools/resources/prompts，并透传 structured tool result', async () => {
    const server: ResolvedMcpServer = {
      name: 'fixture',
      source: 'global',
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      env: {},
      display: { command: process.execPath, args: [fixture], env: [] },
      hash: 'fixture-stdio',
    };

    const connection = await createMcpConnection(server);
    try {
      expect(connection.info()).toMatchObject({
        serverInfo: { name: 'downstream-fixture', version: '1.0.0' },
      });

      expect(connection.info().protocolVersion).toBe('2026-07-28');

      const tools = (await connection.client.listTools()) as {
        tools: Array<{ name: string; annotations?: Record<string, unknown> }>;
      };
      const mrtrTool = tools.tools.find((tool) => tool.name === 'needs_input');
      const manualMrtr = (await connection.client.callTool(
        { name: 'needs_input', arguments: {} },
        { allowInputRequired: true, toolDefinition: mrtrTool },
      )) as Record<string, unknown>;
      expect(manualMrtr['resultType']).toBe('input_required');
      expect(isInputRequiredResult(manualMrtr)).toBe(true);
      expect(manualMrtr['requestState']).toBe('opaque:α/二\nline');
      expect(tools.tools.map((tool) => tool.name)).toContain('echo');
      expect(tools.tools.find((tool) => tool.name === 'echo')?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
      });

      const called = (await connection.client.callTool({
        name: 'echo',
        arguments: { text: 'hello' },
      })) as {
        content: Array<{ type: string; text?: string }>;
        structuredContent?: unknown;
      };
      expect(called.content).toContainEqual({ type: 'text', text: 'hello' });
      expect(called.structuredContent).toEqual({ echoed: 'hello' });

      const resources = (await connection.client.listResources()) as {
        resources: Array<{ uri: string }>;
      };
      expect(resources.resources).toContainEqual(
        expect.objectContaining({ uri: 'fixture://hello' }),
      );
      expect(await connection.client.readResource({ uri: 'fixture://hello' })).toMatchObject({
        contents: [{ uri: 'fixture://hello', text: 'fixture resource' }],
      });

      const prompts = (await connection.client.listPrompts()) as {
        prompts: Array<{ name: string }>;
      };
      expect(prompts.prompts.map((prompt) => prompt.name)).toContain('review');
      expect(await connection.client.getPrompt({
        name: 'review',
        arguments: { code: 'const x = 1;' },
      })).toMatchObject({
        messages: [
          {
            role: 'user',
            content: { type: 'text', text: 'Review: const x = 1;' },
          },
        ],
      });
    } finally {
      await connection.close();
    }
  });
});
