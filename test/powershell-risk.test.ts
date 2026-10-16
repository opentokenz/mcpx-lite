import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzePowerShellAst, analyzePowerShellCommand, parsePowerShellAstResponse } from '../src/powershell-risk.js';

describe('PowerShell AST risk analysis', () => {
  it('requires approval for destructive cmdlets and their common aliases', () => {
    for (const name of ['Remove-Item', 'rm', 'del', 'rmdir']) {
      expect(
        analyzePowerShellAst({
          commands: [{ name, elements: [name, '-Path', 'target.txt', '-Force'] }],
          errors: [],
          hasFileRedirection: false,
        }).risk,
        name,
      ).toBe('dangerous');
    }
  });

  it('reuses Git risk decisions for parsed PowerShell invocations', () => {
    expect(
      analyzePowerShellAst({
        commands: [{ name: 'git', elements: ['git', 'add', 'file.txt'] }],
        errors: [],
        hasFileRedirection: false,
      }).risk,
    ).toBe('unknown');
    expect(
      analyzePowerShellAst({
        commands: [{ name: 'git', elements: ['git', 'reset', '--hard'] }],
        errors: [],
        hasFileRedirection: false,
      }).risk,
    ).toBe('dangerous');
  });

  it('requires approval for PowerShell package, disk, ACL, and registry mutations', () => {
    for (const name of ['Install-Module', 'Uninstall-Package', 'Format-Volume', 'Clear-Disk', 'Set-Acl', 'winget']) {
      expect(
        analyzePowerShellAst({
          commands: [{ name, elements: [name, 'target'] }],
          errors: [],
          hasFileRedirection: false,
        }).risk,
        name,
      ).toBe('dangerous');
    }

    expect(
      analyzePowerShellAst({
        commands: [{ name: 'reg.exe', elements: ['reg.exe', 'add', 'HKCU\\Software\\example'] }],
        errors: [],
        hasFileRedirection: false,
      }).risk,
    ).toBe('dangerous');
    expect(
      analyzePowerShellAst({
        commands: [{ name: 'reg.exe', elements: ['reg.exe', 'query', 'HKCU\\Software\\example'] }],
        errors: [],
        hasFileRedirection: false,
      }).risk,
    ).toBe('unknown');
  });

  it('marks PowerShell output redirection and dynamic invocations as not safe', () => {
    expect(
      analyzePowerShellAst({ commands: [], errors: [], hasFileRedirection: true }).risk,
    ).toBe('dangerous');
    expect(
      analyzePowerShellAst({
        commands: [{ name: null, elements: ['&', '$script'] }],
        errors: [],
        hasFileRedirection: false,
      }).risk,
    ).toBe('unknown');
  });

  it('rejects parser errors before a command can be executed', () => {
    expect(() =>
      analyzePowerShellAst({ commands: [], errors: ['Unexpected token'], hasFileRedirection: false }),
    ).toThrow(/PowerShell syntax error/);
  });

  it('fails closed when the parser process returns malformed JSON or an unexpected exit code', () => {
    expect(() => parsePowerShellAstResponse('not json', 0, '')).toThrow(/invalid output/);
    expect(() =>
      parsePowerShellAstResponse(
        JSON.stringify({ errors: [], commands: [], hasFileRedirection: false }),
        1,
        'parser crashed',
      ),
    ).toThrow(/parser crashed/);
  });

  it.skipIf(process.platform !== 'win32')('parses PowerShell without executing nested commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcpx-lite-ps-'));
    const marker = join(root, 'marker.txt');
    try {
      const command = `$(Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value 'executed')`;
      expect((await analyzePowerShellCommand(command)).risk).toBe('dangerous');
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'win32')('rejects PowerShell syntax errors before execution', async () => {
    await expect(analyzePowerShellCommand('if (')).rejects.toThrow(/PowerShell syntax error/);
  });
});
