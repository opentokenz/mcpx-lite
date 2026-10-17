import { win32 } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildWindowsBatchLaunch, windowsSystemPath } from '../src/windows-runtime.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Windows system executable paths', () => {
  it('resolves built-in executables under SystemRoot instead of PATH', () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows');

    expect(windowsSystemPath('WindowsPowerShell', 'v1.0', 'powershell.exe')).toBe(
      win32.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    );
    expect(windowsSystemPath('taskkill.exe')).toBe(win32.join('C:\\Windows', 'System32', 'taskkill.exe'));
  });

  it('fails rather than falling back to PATH when SystemRoot is missing or relative', () => {
    vi.stubEnv('SystemRoot', '');
    expect(() => windowsSystemPath('powershell.exe')).toThrow(/SystemRoot/);

    vi.stubEnv('SystemRoot', 'Windows');
    expect(() => windowsSystemPath('powershell.exe')).toThrow(/SystemRoot/);
  });

  it('launches .cmd/.bat through encoded PowerShell without shell interpolation', () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    const launch = buildWindowsBatchLaunch(
      'C:\\Program Files\\MCP\\server.cmd',
      ['space & pipe | value', "single'quote", '%PATH%'],
      'win32',
    );
    const encodedIndex = launch?.args.indexOf('-EncodedCommand') ?? -1;
    const script = Buffer.from(launch?.args[encodedIndex + 1] ?? '', 'base64').toString('utf16le');

    expect(launch?.command).toBe(
      win32.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    );
    expect(encodedIndex).toBeGreaterThan(-1);
    expect(script).toContain("$commandPath = 'C:\\Program Files\\MCP\\server.cmd'");
    expect(script).toContain("'space & pipe | value', 'single''quote', '%PATH%'");
    expect(script).toContain('& $commandPath @forwardedArgs');
    expect(script).not.toContain('[Console]::OutputEncoding');
    expect(script).not.toContain('$OutputEncoding =');
    expect(script).not.toContain('[Console]::InputEncoding');
  });

  it('leaves executables and non-Windows commands unchanged', () => {
    expect(buildWindowsBatchLaunch('C:\\mcp\\server.exe', ['arg'], 'win32')).toBeNull();
    expect(buildWindowsBatchLaunch('server.cmd', ['arg'], 'linux')).toBeNull();
  });
});
