import { windowsSystemPath } from '../windows-runtime.js';

export interface ShellLaunch {
  command: string;
  args: string[];
  detached: boolean;
}

export type TreeKill =
  | { command: string; args: string[] }
  | { processGroup: number; signal: 'SIGKILL' };

export function buildShellLaunch(command: string, platform: NodeJS.Platform = process.platform): ShellLaunch {
  if (platform !== 'win32') {
    return { command: '/bin/bash', args: ['-c', command], detached: true };
  }

  return {
    command: windowsSystemPath('WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(command)],
    detached: false,
  };
}

export function buildTreeKill(pid: number, platform: NodeJS.Platform = process.platform): TreeKill {
  if (platform === 'win32') {
    return { command: windowsSystemPath('taskkill.exe'), args: ['/PID', String(pid), '/T', '/F'] };
  }

  return { processGroup: -pid, signal: 'SIGKILL' };
}

function encodePowerShellCommand(command: string): string {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    '$OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    '$global:LASTEXITCODE = $null',
    'try {',
    command,
    '  $commandSucceeded = $? ',
    '  if ($commandSucceeded) { exit 0 }',
    '  if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    '  exit 1',
    '} catch {',
    '  [Console]::Error.WriteLine($_.ToString())',
    '  exit 1',
    '}',
  ].join('\n');

  return Buffer.from(script, 'utf16le').toString('base64');
}
