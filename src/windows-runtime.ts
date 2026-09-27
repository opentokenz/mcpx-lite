import { win32 } from 'node:path';

export function windowsSystemPath(...segments: string[]): string {
  const systemRoot = process.env['SystemRoot'] ?? process.env['WINDIR'];
  if (!systemRoot || !win32.isAbsolute(systemRoot)) {
    throw new Error('SystemRoot must be an absolute path to locate Windows system executables');
  }

  return win32.join(systemRoot, 'System32', ...segments);
}

export function buildWindowsBatchLaunch(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } | null {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(command)) return null;

  const forwardedArgs = args.map(powershellString).join(', ');
  const script = [
    '$ErrorActionPreference = "Stop"',
    '[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)',
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    '$OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    `$commandPath = ${powershellString(command)}`,
    `$forwardedArgs = @(${forwardedArgs})`,
    '& $commandPath @forwardedArgs',
    '$commandSucceeded = $?',
    '$nativeExitCode = $LASTEXITCODE',
    'if ($null -ne $nativeExitCode) { exit $nativeExitCode }',
    'if ($commandSucceeded) { exit 0 }',
    'exit 1',
  ].join('\n');

  return {
    command: windowsSystemPath('WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  };
}

function powershellString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
