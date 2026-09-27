import { win32 } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildShellLaunch, buildTreeKill } from '../src/tools/shell-runtime.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('shell runtime platform launch', () => {
  it('starts Windows PowerShell with an encoded UTF-16LE command and UTF-8 pipes', () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    const launch = buildShellLaunch('Write-Output "你好"', 'win32');
    const encodedIndex = launch.args.indexOf('-EncodedCommand');
    const script = Buffer.from(launch.args[encodedIndex + 1] ?? '', 'base64').toString('utf16le');

    expect(launch.command).toBe(
      win32.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    );
    expect(launch.detached).toBe(false);
    expect(encodedIndex).toBeGreaterThan(-1);
    expect(script).toContain('Write-Output "你好"');
    expect(script).toContain('[Console]::OutputEncoding');
    expect(launch.args).toContain('-NoProfile');
    expect(launch.args).toContain('-NonInteractive');
  });

  it('preserves Bash launch and detached process groups on POSIX', () => {
    expect(buildShellLaunch('printf ok', 'darwin')).toEqual({
      command: '/bin/bash',
      args: ['-c', 'printf ok'],
      detached: true,
    });
  });

  it('uses taskkill tree mode on Windows and a negative process-group signal on POSIX', () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    expect(buildTreeKill(1234, 'win32')).toEqual({
      command: win32.join('C:\\Windows', 'System32', 'taskkill.exe'),
      args: ['/PID', '1234', '/T', '/F'],
    });
    expect(buildTreeKill(1234, 'linux')).toEqual({
      processGroup: -1234,
      signal: 'SIGKILL',
    });
  });
});
