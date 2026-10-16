import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpConnection } from '../src/mcp-client.js';
import { loadMcpConfig, resolveMcpServerConfig } from '../src/mcp-config.js';
import { McpManager } from '../src/mcp-manager.js';
import {
  approvalRetryBody,
  createHarness,
  expectApproval,
  expectOk,
  mrtrRetryBody,
  toOutcome,
  toolCallBody,
  type Harness,
} from './harness.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'downstream-mcp.mjs');

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.cleanup();
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), 'utf8');
}

async function createSession(): Promise<string> {
  const created = expectOk(
    await h.callTool('session', { action: 'create', workspace: h.workspace }),
  );
  return created['sessionId'] as string;
}

describe('mcp_tool catalog actions', () => {
  it('list 合并 global/project，project 同名整项覆盖，且不泄漏 secret', async () => {
    const globalPath = join(h.home, '.agents', 'mcp.json');
    await writeJson(globalPath, {
      mcpServers: {
        shared: {
          url: 'https://global.example.test/mcp',
          headers: { Authorization: 'Bearer GLOBAL_SECRET' },
        },
        globalOnly: { command: '/usr/bin/true', env: { TOKEN: 'GLOBAL_ENV_SECRET' } },
      },
    });
    await writeJson(join(h.workspace, '.mcp.json'), {
      mcpServers: {
        shared: {
          url: 'https://project.example.test/mcp',
          headers: { Authorization: 'Bearer PROJECT_SECRET' },
        },
      },
    });
    const sessionId = await createSession();

    const listed = expectOk(await h.callTool('mcp_tool', { action: 'list', sessionId }));
    expect(listed['servers']).toEqual([
      {
        name: 'globalOnly',
        source: 'global',
        transport: 'stdio',
        config: { command: '/usr/bin/true', args: [], env: ['TOKEN'] },
      },
      {
        name: 'shared',
        source: 'project',
        transport: 'http',
        config: { url: 'https://project.example.test/mcp', headers: ['Authorization'] },
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain('GLOBAL_SECRET');
    expect(JSON.stringify(listed)).not.toContain('PROJECT_SECRET');
    expect(JSON.stringify(listed)).not.toContain('GLOBAL_ENV_SECRET');
  });

  it('status 不主动连接 server，初始状态为 disconnected', async () => {
    await writeJson(join(h.home, '.agents', 'mcp.json'), {
      mcpServers: {
        local: { command: '/usr/bin/true' },
      },
    });
    const sessionId = await createSession();

    const status = expectOk(await h.callTool('mcp_tool', { action: 'status', sessionId }));

    expect(status['servers']).toEqual([
      expect.objectContaining({
        name: 'local',
        source: 'global',
        transport: 'stdio',
        state: 'disconnected',
      }),
    ]);
  });

  it('reload 重新读取配置并返回最新 effective servers', async () => {
    const globalPath = join(h.home, '.agents', 'mcp.json');
    await writeJson(globalPath, { mcpServers: { before: { command: '/usr/bin/true' } } });
    const sessionId = await createSession();

    expect(expectOk(await h.callTool('mcp_tool', { action: 'list', sessionId }))['servers']).toHaveLength(1);

    await writeJson(globalPath, { mcpServers: { after: { command: '/usr/bin/false' } } });
    const reloaded = expectOk(await h.callTool('mcp_tool', { action: 'reload', sessionId }));

    expect(reloaded['servers']).toEqual([
      expect.objectContaining({ name: 'after', source: 'global', transport: 'stdio' }),
    ]);
  });

  it('inspect 全局 server 直接连接并透传 server info 与 catalog', async () => {
    await writeJson(join(h.home, '.agents', 'mcp.json'), {
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [fixture],
        },
      },
    });
    const sessionId = await createSession();

    const inspected = expectOk(
      await h.callTool('mcp_tool', { action: 'inspect', sessionId, server: 'fixture' }),
    );

    expect(inspected).toMatchObject({
      server: { name: 'fixture', source: 'global', transport: 'stdio' },
      serverInfo: { name: 'downstream-fixture', version: '1.0.0' },
    });
    expect((inspected['tools'] as Array<{ name: string }>).map((tool) => tool.name)).toContain('echo');
    expect((inspected['resources'] as Array<{ uri: string }>).map((resource) => resource.uri)).toContain(
      'fixture://hello',
    );
    expect((inspected['prompts'] as Array<{ name: string }>).map((prompt) => prompt.name)).toContain('review');
  });

  it('inspect 不调用 server 未声明的 primitive，并以空 catalog 返回', async () => {
    const calls = { tools: 0, resources: 0, templates: 0, prompts: 0 };
    const fakeConnection: McpConnection = {
      client: {
        connect: async () => undefined,
        close: async () => undefined,
        getServerCapabilities: () => ({ tools: {} }),
        getServerVersion: () => ({ name: 'limited', version: '1.0.0' }),
        getNegotiatedProtocolVersion: () => '2026-07-28',
        getInstructions: () => undefined,
        listTools: async () => {
          calls.tools += 1;
          return { tools: [] };
        },
        listResources: async () => {
          calls.resources += 1;
          return { resources: [] };
        },
        listResourceTemplates: async () => {
          calls.templates += 1;
          return { resourceTemplates: [] };
        },
        listPrompts: async () => {
          calls.prompts += 1;
          return { prompts: [] };
        },
        callTool: async () => ({ content: [] }),
        readResource: async () => ({ contents: [] }),
        getPrompt: async () => ({ messages: [] }),
      },
      info: () => ({
        protocolVersion: '2026-07-28',
        serverInfo: { name: 'limited', version: '1.0.0' },
        capabilities: { tools: {} },
      }),
      close: async () => undefined,
    };
    h.deps.mcpManager = new McpManager({ connect: async () => fakeConnection });
    await writeJson(join(h.home, '.agents', 'mcp.json'), {
      mcpServers: { limited: { command: '/usr/bin/true' } },
    });
    const sessionId = await createSession();

    const inspected = expectOk(
      await h.callTool('mcp_tool', { action: 'inspect', sessionId, server: 'limited' }),
    );

    expect(calls).toEqual({ tools: 1, resources: 0, templates: 0, prompts: 0 });
    expect(inspected['resources']).toEqual([]);
    expect(inspected['resourceTemplates']).toEqual([]);
    expect(inspected['prompts']).toEqual([]);
  });


  it('call readonly tool 首次审批后原样保留 content / structuredContent', async () => {
    await writeJson(join(h.home, '.agents', 'mcp.json'), {
      mcpServers: {
        fixture: { command: process.execPath, args: [fixture] },
      },
    });
    const sessionId = await createSession();

    const outcome = await h.callToolApproving('mcp_tool', {
      action: 'call',
      sessionId,
      server: 'fixture',
      name: 'echo',
      arguments: { text: 'hello-through-gateway' },
    });

    expect(outcome.isError).toBe(false);
    expect(outcome.content).toContainEqual({ type: 'text', text: 'hello-through-gateway' });
    expect(outcome.structuredContent).toEqual({ echoed: 'hello-through-gateway' });
  });

  it('call destructive tool 首次审批，批准后同 server 后续调用免审批', async () => {
    const marker = join(h.workspace, 'mutation.marker');
    await writeJson(join(h.home, '.agents', 'mcp.json'), {
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [fixture],
          env: { FIXTURE_MUTATION_MARKER: marker },
        },
      },
    });
    const sessionId = await createSession();
    const firstArgs = {
      action: 'call',
      sessionId,
      server: 'fixture',
      name: 'mutate',
      arguments: { value: 'direct-value' },
    };

    const token = expectApproval(await h.callTool('mcp_tool', firstArgs)).approvalToken;
    await expect(access(marker)).rejects.toThrow();

    const result = toOutcome(
      await h.client.send(approvalRetryBody('mcp_tool', firstArgs, token)),
    );

    expect(result.isError).toBe(false);
    expect(result.resultType).not.toBe('approval_required');
    expect(await readFile(marker, 'utf8')).toBe('direct-value');
    expect(result.content).toContainEqual({ type: 'text', text: 'mutated:direct-value' });

    const trusted = await h.callTool('mcp_tool', {
      action: 'call',
      sessionId,
      server: 'fixture',
      name: 'unannotated',
      arguments: { value: 'trusted' },
    });
    expect(trusted.isError).toBe(false);
    expect(trusted.resultType).not.toBe('approval_required');
    expect(trusted.content).toContainEqual({ type: 'text', text: 'unannotated:trusted' });
  });

  it('call unannotated tool 首次仍要求审批，批准后执行', async () => {
    await writeJson(join(h.home, '.agents', 'mcp.json'), {
      mcpServers: {
        fixture: { command: process.execPath, args: [fixture] },
      },
    });
    const sessionId = await createSession();

    const args = {
      action: 'call',
      sessionId,
      server: 'fixture',
      name: 'unannotated',
      arguments: { value: 'x' },
    };

    const token = expectApproval(await h.callTool('mcp_tool', args)).approvalToken;
    const outcome = toOutcome(await h.client.send(approvalRetryBody('mcp_tool', args, token)));

    expect(outcome.isError).toBe(false);
    expect(outcome.resultType).not.toBe('approval_required');
    expect(outcome.content).toContainEqual({ type: 'text', text: 'unannotated:x' });
  });

  it('session close 释放下游连接并清除信任，resume 后重新要求 call 审批', async () => {
    await writeJson(join(h.home, '.agents', 'mcp.json'), {
      mcpServers: {
        fixture: { command: process.execPath, args: [fixture] },
      },
    });
    const sessionId = await createSession();
    const effective = await loadMcpConfig({ workspace: h.workspace, globalPath: h.deps.mcpGlobalPath });
    const resolved = resolveMcpServerConfig(effective.servers['fixture']!);
    const args = {
      action: 'call',
      sessionId,
      server: 'fixture',
      name: 'unannotated',
      arguments: { value: 'before-close' },
    };

    const approval = expectApproval(await h.callTool('mcp_tool', args));
    const completed = toOutcome(
      await h.client.send(approvalRetryBody('mcp_tool', args, approval.approvalToken)),
    );
    expect(completed.isError).toBe(false);
    expect(h.deps.mcpManager.status(resolved).state).toBe('connected');
    expect(h.deps.mcpTrust.isCallsTrusted(sessionId, 'fixture', resolved.hash)).toBe(true);

    expectOk(await h.callTool('session', { action: 'close', sessionId }));

    expect(h.deps.mcpManager.status(resolved).state).toBe('disconnected');
    expect(h.deps.mcpTrust.isCallsTrusted(sessionId, 'fixture', resolved.hash)).toBe(false);

    expectOk(await h.callTool('session', { action: 'resume', sessionId }));
    expectApproval(
      await h.callTool('mcp_tool', {
        ...args,
        arguments: { value: 'after-resume' },
      }),
    );
  });

  it('call 透传 downstream input_required，并 byte-exact 回送 requestState/inputResponses', async () => {
    await writeJson(join(h.home, '.agents', 'mcp.json'), {
      mcpServers: {
        fixture: { command: process.execPath, args: [fixture] },
      },
    });
    const sessionId = await createSession();
    const baseArgs = {
      action: 'call',
      sessionId,
      server: 'fixture',
      name: 'needs_input',
      arguments: {},
    };

    const firstBody = await h.client.send(toolCallBody('mcp_tool', baseArgs));
    const approval = expectApproval(toOutcome(firstBody));
    const approvedBody = await h.client.send(
      approvalRetryBody('mcp_tool', baseArgs, approval.approvalToken),
    );
    const approved = approvedBody['result'] as Record<string, unknown>;

    expect(approved['resultType']).toBe('input_required');
    expect(approved['requestState']).toBe('opaque:α/二\nline');
    expect(approved['inputRequests']).toHaveProperty('answer');

    const responses = {
      answer: {
        action: 'accept',
        content: { value: 'from-user' },
      },
    };
    const second = toOutcome(
      await h.client.send(
        mrtrRetryBody(
          'mcp_tool',
          baseArgs,
          approved['requestState'] as string,
          responses,
        ),
      ),
    );

    expect(second.isError).toBe(false);
    expect(second.structuredContent).toEqual({
      state: 'opaque:α/二\nline',
      responses,
    });
  });

  it('read_resource 与 get_prompt 透传 downstream primitive 结果', async () => {
    await writeJson(join(h.home, '.agents', 'mcp.json'), {
      mcpServers: {
        fixture: { command: process.execPath, args: [fixture] },
      },
    });
    const sessionId = await createSession();

    const resource = expectOk(
      await h.callTool('mcp_tool', {
        action: 'read_resource',
        sessionId,
        server: 'fixture',
        uri: 'fixture://hello',
      }),
    );
    expect(resource).toMatchObject({
      contents: [{ uri: 'fixture://hello', text: 'fixture resource' }],
    });

    const prompt = expectOk(
      await h.callTool('mcp_tool', {
        action: 'get_prompt',
        sessionId,
        server: 'fixture',
        name: 'review',
        arguments: { code: 'const x = 1;' },
      }),
    );
    expect(prompt).toMatchObject({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: 'Review: const x = 1;' },
        },
      ],
    });
  });

  it('read_resource 与 get_prompt 透传 downstream input_required 和 byte-exact requestState', async () => {
    await writeJson(join(h.home, '.agents', 'mcp.json'), {
      mcpServers: {
        fixture: { command: process.execPath, args: [fixture] },
      },
    });
    const sessionId = await createSession();
    const responses = {
      answer: {
        action: 'accept',
        content: { value: 'from-user' },
      },
    };

    const resourceArgs = {
      action: 'read_resource',
      sessionId,
      server: 'fixture',
      uri: 'fixture://needs-input',
    };
    const resourceFirstBody = await h.client.send(toolCallBody('mcp_tool', resourceArgs));
    expect(resourceFirstBody['error']).toBeUndefined();
    const resourceFirst = resourceFirstBody['result'] as Record<string, unknown>;
    expect(resourceFirst['resultType']).toBe('input_required');
    expect(resourceFirst['requestState']).toBe('resource-state:α/二\nline');

    const resourceSecond = toOutcome(
      await h.client.send(
        mrtrRetryBody(
          'mcp_tool',
          resourceArgs,
          resourceFirst['requestState'] as string,
          responses,
        ),
      ),
    );
    expect(resourceSecond.isError).toBe(false);
    const resourceData = resourceSecond.data as {
      contents: Array<{ text?: string }>;
    };
    expect(JSON.parse(resourceData.contents[0]?.text ?? '{}')).toEqual({
      state: 'resource-state:α/二\nline',
      responses,
    });

    const promptArgs = {
      action: 'get_prompt',
      sessionId,
      server: 'fixture',
      name: 'needs_input_prompt',
      arguments: {},
    };
    const promptFirstBody = await h.client.send(toolCallBody('mcp_tool', promptArgs));
    expect(promptFirstBody['error']).toBeUndefined();
    const promptFirst = promptFirstBody['result'] as Record<string, unknown>;
    expect(promptFirst['resultType']).toBe('input_required');
    expect(promptFirst['requestState']).toBe('prompt-state:α/二\nline');

    const promptSecond = toOutcome(
      await h.client.send(
        mrtrRetryBody(
          'mcp_tool',
          promptArgs,
          promptFirst['requestState'] as string,
          responses,
        ),
      ),
    );
    expect(promptSecond.isError).toBe(false);
    const promptData = promptSecond.data as {
      messages: Array<{ content?: { text?: string } }>;
    };
    expect(JSON.parse(promptData.messages[0]?.content?.text ?? '{}')).toEqual({
      state: 'prompt-state:α/二\nline',
      responses,
    });
  });

  it('call project server 首次连接审批同时授权首次调用，不重复审批', async () => {
    await writeJson(join(h.workspace, '.mcp.json'), {
      mcpServers: {
        fixture: { command: process.execPath, args: [fixture] },
      },
    });
    const sessionId = await createSession();
    const args = {
      action: 'call',
      sessionId,
      server: 'fixture',
      name: 'echo',
      arguments: { text: 'project-first-call' },
    };

    const approval = expectApproval(await h.callTool('mcp_tool', args));
    expect(approval.approval.riskLabel).toMatch(/mcp\.tool/);
    expect(approval.approval.message).toContain('echo');

    const tampered = {
      ...args,
      name: 'unannotated',
      arguments: { value: 'tampered' },
    };
    const rejected = toOutcome(
      await h.client.send(approvalRetryBody('mcp_tool', tampered, approval.approvalToken)),
    );
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toMatch(/不匹配/);

    const retryApproval = expectApproval(await h.callTool('mcp_tool', args));
    const result = toOutcome(
      await h.client.send(approvalRetryBody('mcp_tool', args, retryApproval.approvalToken)),
    );

    expect(result.isError).toBe(false);
    expect(result.resultType).not.toBe('approval_required');
    expect(result.structuredContent).toEqual({ echoed: 'project-first-call' });
  });

  it('inspect project server 审批前不 spawn，批准后才连接；goal/reason 可变化', async () => {
    const marker = join(h.workspace, 'fixture-started.marker');
    await writeJson(join(h.workspace, '.mcp.json'), {
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [fixture],
          env: { FIXTURE_START_MARKER: marker },
        },
      },
    });
    const sessionId = await createSession();
    const firstArgs = {
      action: 'inspect',
      sessionId,
      server: 'fixture',
      goal: '首轮目标',
      reason: '首轮原因',
    };

    const token = expectApproval(await h.callTool('mcp_tool', firstArgs)).approvalToken;
    await expect(access(marker)).rejects.toThrow();

    const retryArgs = {
      action: 'inspect',
      sessionId,
      server: 'fixture',
      goal: '二次目标不同',
      reason: '二次原因不同',
    };
    const retry = toOutcome(
      await h.client.send(approvalRetryBody('mcp_tool', retryArgs, token)),
    );

    expect(retry.isError).toBe(false);
    await expect(access(marker)).resolves.toBeUndefined();
    expect(retry.data).toMatchObject({
      serverInfo: { name: 'downstream-fixture', version: '1.0.0' },
    });
  });
});
