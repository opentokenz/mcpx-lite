import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SKILLS_SUBDIR } from '../src/skills.js';

describe('runtime CLI arguments', () => {
  it('omits Bun standalone entrypoint paths from runtime arguments', async () => {
    const { getCliArgs } = await import('../src/index.js');

    expect(getCliArgs(['/tmp/mcpx-lite', '/$bunfs/root/mcpx-lite', '--daemon', '--port', '3000']))
      .toEqual(['--daemon', '--port', '3000']);
  });

  it('uses an explicit CLI port before the environment and default port', async () => {
    const { loadConfig } = await import('../src/index.js');

    expect(loadConfig({}, 12345).port).toBe(12345);
    expect(loadConfig({ MCPX_LITE_PORT: '9000' }).port).toBe(9000);
    expect(loadConfig({}).port).toBe(29090);
  });

  it('uses mcpx-lite configuration names and its new default home', async () => {
    const { loadConfig } = await import('../src/index.js');

    expect(loadConfig({
      MCPX_LITE_HOST: '0.0.0.0',
      MCPX_LITE_PORT: '9300',
      MCPX_LITE_HOME: '/tmp/mcpx-home',
      MCPX_LITE_GLOBAL_SKILLS: '/tmp/mcpx-skills',
      MCPX_LITE_LOG: 'off',
    })).toMatchObject({
      host: '0.0.0.0',
      port: 9300,
      home: '/tmp/mcpx-home',
      globalSkillsDir: '/tmp/mcpx-skills',
      logLevel: 'off',
    });
    expect(loadConfig({}).home).toBe(join(homedir(), '.mcpx-lite'));
    expect(loadConfig({}).approvalsEnabled).toBe(true);
    expect(loadConfig({ MCPX_LITE_APPROVALS: 'off' }).approvalsEnabled).toBe(false);
  });

  it('ignores legacy MINI_PI_MCP configuration names', async () => {
    const { loadConfig } = await import('../src/index.js');

    expect(loadConfig({
      MINI_PI_MCP_HOST: '0.0.0.0',
      MINI_PI_MCP_PORT: '9300',
      MINI_PI_MCP_HOME: '/tmp/old-home',
      MINI_PI_MCP_GLOBAL_SKILLS: '/tmp/old-skills',
      MINI_PI_MCP_LOG: 'off',
    })).toMatchObject({
      host: '127.0.0.1',
      port: 29090,
      home: join(homedir(), '.mcpx-lite'),
      globalSkillsDir: join(homedir(), SKILLS_SUBDIR),
      logLevel: 'debug',
    });
  });

  it('supports foreground, daemon (-d/--daemon), and stop modes', async () => {
    const { parseCliArgs } = await import('../src/index.js');

    expect(parseCliArgs([])).toEqual({ mode: 'foreground' });
    expect(parseCliArgs(['--daemon'])).toEqual({ mode: 'daemon' });
    expect(parseCliArgs(['-d'])).toEqual({ mode: 'daemon' });
    expect(parseCliArgs(['--stop'])).toEqual({ mode: 'stop' });
    expect(parseCliArgs(['--port', '3000'])).toEqual({ mode: 'foreground', port: 3000 });
    expect(parseCliArgs(['-p', '4000'])).toEqual({ mode: 'foreground', port: 4000 });
    expect(parseCliArgs(['-d', '-p', '5000'])).toEqual({ mode: 'daemon', port: 5000 });
    expect(parseCliArgs(['--no-approval'])).toEqual({ mode: 'foreground', approvalsEnabled: false });
    expect(parseCliArgs(['-d', '--no-approval', '-p', '5000'])).toEqual({
      mode: 'daemon',
      port: 5000,
      approvalsEnabled: false,
    });
  });

  it('rejects conflicting and unknown runtime arguments', async () => {
    const { parseCliArgs } = await import('../src/index.js');

    expect(() => parseCliArgs(['--daemon', '--stop'])).toThrow(/cannot be combined/i);
    expect(() => parseCliArgs(['--unknown'])).toThrow(/unknown argument/i);
    expect(() => parseCliArgs(['--port'])).toThrow(/requires a value/i);
    expect(() => parseCliArgs(['--port', 'abc'])).toThrow(/valid port/i);
    expect(() => parseCliArgs(['--port', '65536'])).toThrow(/valid port/i);
  });
});
