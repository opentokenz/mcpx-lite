import { spawn } from 'node:child_process';
import { win32 } from 'node:path';
import { ToolError } from './errors.js';
import { analyzeShellCommand, type ShellFinding, type ShellRisk, type ShellRiskAnalysis } from './risk.js';
import { windowsSystemPath } from './windows-runtime.js';

export interface PowerShellCommandAst {
  name: string | null;
  elements: string[];
}

export interface PowerShellAstSummary {
  commands: PowerShellCommandAst[];
  errors: string[];
  hasFileRedirection: boolean;
}

const MAX_PARSER_OUTPUT = 1_000_000;
const PARSER_TIMEOUT_MS = 10_000;

const POWERSHELL_ALIASES: Record<string, string> = {
  ac: 'add-content',
  cpi: 'copy-item',
  cp: 'copy-item',
  copy: 'copy-item',
  clc: 'clear-content',
  del: 'remove-item',
  erase: 'remove-item',
  kill: 'stop-process',
  mi: 'move-item',
  move: 'move-item',
  mv: 'move-item',
  md: 'new-item',
  ni: 'new-item',
  rd: 'remove-item',
  ri: 'remove-item',
  rm: 'remove-item',
  rmdir: 'remove-item',
  sc: 'set-content',
  sp: 'set-content',
};

const POWERSHELL_DANGEROUS: Record<string, { kind: string; reason: string }> = {
  'add-content': { kind: 'fs.write', reason: '会向文件追加内容' },
  'clear-content': { kind: 'fs.write', reason: '会清空文件内容' },
  'clear-disk': { kind: 'sys.disk', reason: '会清除磁盘分区与数据' },
  choco: { kind: 'pkg.manage', reason: '会安装、升级或删除软件包' },
  'copy-item': { kind: 'fs.cp', reason: '会复制或覆盖文件' },
  'export-csv': { kind: 'fs.write', reason: '会写入 CSV 文件' },
  'export-clixml': { kind: 'fs.write', reason: '会写入文件' },
  'format-volume': { kind: 'sys.disk', reason: '会格式化磁盘卷' },
  icacls: { kind: 'fs.chmod', reason: '会修改文件访问控制列表' },
  'initialize-disk': { kind: 'sys.disk', reason: '会初始化磁盘并改写分区信息' },
  'install-module': { kind: 'pkg.manage', reason: '会安装 PowerShell 模块' },
  'install-package': { kind: 'pkg.manage', reason: '会安装软件包' },
  'invoke-command': { kind: 'proc.remote', reason: '会在远程计算机执行命令' },
  'invoke-expression': { kind: 'shell.interpreter', reason: '会执行动态生成的 PowerShell 代码' },
  'invoke-restmethod': { kind: 'net.fetch', reason: '会发起网络请求' },
  'invoke-webrequest': { kind: 'net.fetch', reason: '会发起网络请求或下载文件' },
  'move-item': { kind: 'fs.mv', reason: '会移动或重命名文件' },
  'new-item': { kind: 'fs.write', reason: '会创建文件、目录或系统项' },
  'new-itemproperty': { kind: 'sys.config', reason: '会创建系统属性' },
  'new-partition': { kind: 'sys.disk', reason: '会创建磁盘分区' },
  'new-service': { kind: 'sys.service', reason: '会创建系统服务' },
  'new-scheduledtask': { kind: 'sys.config', reason: '会创建计划任务' },
  'out-file': { kind: 'fs.write', reason: '会写入文件' },
  'register-scheduledtask': { kind: 'sys.config', reason: '会注册计划任务' },
  'remove-item': { kind: 'fs.rm', reason: '会删除文件、目录或系统项' },
  'remove-itemproperty': { kind: 'sys.config', reason: '会删除系统属性' },
  'remove-partition': { kind: 'sys.disk', reason: '会删除磁盘分区' },
  'remove-service': { kind: 'sys.service', reason: '会删除系统服务' },
  'restart-computer': { kind: 'sys.power', reason: '会重启计算机' },
  'restart-service': { kind: 'sys.service', reason: '会重启系统服务' },
  'set-content': { kind: 'fs.write', reason: '会写入或覆盖文件内容' },
  'set-acl': { kind: 'fs.chmod', reason: '会修改文件访问控制列表' },
  'set-executionpolicy': { kind: 'sys.config', reason: '会修改 PowerShell 执行策略' },
  'set-item': { kind: 'sys.config', reason: '会修改系统项' },
  'set-itemproperty': { kind: 'sys.config', reason: '会修改系统属性' },
  'set-service': { kind: 'sys.service', reason: '会修改系统服务配置' },
  scoop: { kind: 'pkg.manage', reason: '会安装、升级或删除软件包' },
  'start-bitstransfer': { kind: 'net.fetch', reason: '会下载或上传文件' },
  'start-process': { kind: 'proc.start', reason: '会启动外部进程' },
  'start-service': { kind: 'sys.service', reason: '会启动系统服务' },
  'stop-computer': { kind: 'sys.power', reason: '会关闭计算机' },
  'stop-process': { kind: 'proc.kill', reason: '会终止进程' },
  'stop-service': { kind: 'sys.service', reason: '会停止系统服务' },
  takeown: { kind: 'fs.chown', reason: '会修改文件所有者' },
  'uninstall-module': { kind: 'pkg.manage', reason: '会删除 PowerShell 模块' },
  'uninstall-package': { kind: 'pkg.manage', reason: '会删除软件包' },
  'update-module': { kind: 'pkg.manage', reason: '会更新 PowerShell 模块' },
  'update-package': { kind: 'pkg.manage', reason: '会更新软件包' },
  'set-partition': { kind: 'sys.disk', reason: '会修改磁盘分区' },
  winget: { kind: 'pkg.manage', reason: '会安装、升级或删除软件包' },
};

const REGISTRY_MUTATION_ACTIONS = new Set(['add', 'copy', 'delete', 'import', 'load', 'restore', 'unload']);

const POWERSHELL_PARSER = [
  '$ErrorActionPreference = \'Stop\'',
  '[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)',
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
  '$source = [Console]::In.ReadToEnd()',
  '$tokens = $null',
  '$errors = $null',
  '$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)',
  '$commands = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object {',
  '  [ordered]@{ name = $_.GetCommandName(); elements = @($_.CommandElements | ForEach-Object { $_.Extent.Text }) }',
  '})',
  '$redirects = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FileRedirectionAst] }, $true))',
  '$payload = [ordered]@{ errors = @($errors | ForEach-Object { $_.Message }); commands = $commands; hasFileRedirection = ($redirects.Count -gt 0) }',
  '[Console]::Out.Write((ConvertTo-Json -InputObject $payload -Compress -Depth 8))',
  'if ($errors.Count -gt 0) { exit 2 }',
].join('\n');

export function analyzePowerShellAst(parsed: PowerShellAstSummary): ShellRiskAnalysis {
  if (parsed.errors.length > 0) {
    throw new ToolError(`PowerShell syntax error: ${parsed.errors.join('; ')}`);
  }

  const findings = parsed.commands.flatMap(classifyPowerShellCommand);
  if (parsed.hasFileRedirection) {
    findings.push({
      command: 'PowerShell output redirection',
      kind: 'fs.redirect',
      risk: 'dangerous',
      reason: '会写入或覆盖文件',
    });
  }

  if (findings.length === 0) {
    findings.push({
      command: '',
      kind: 'unknown',
      risk: 'unknown',
      reason: '无法从 PowerShell AST 确认命令安全',
    });
  }

  return { risk: aggregate(findings), findings };
}

export function analyzePowerShellCommand(command: string): Promise<ShellRiskAnalysis> {
  return runPowerShellParser(command).then(analyzePowerShellAst);
}

export function parsePowerShellAstResponse(
  stdout: string,
  exitCode: number | null,
  stderr: string,
): PowerShellAstSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ToolError(`PowerShell AST parser returned invalid output: ${stderr.trim() || 'no details'}`);
  }

  if (!isPowerShellAstSummary(parsed)) {
    throw new ToolError('PowerShell AST parser returned an invalid response');
  }
  if (exitCode !== 0 && !(exitCode === 2 && parsed.errors.length > 0)) {
    throw new ToolError(`PowerShell AST parser failed: ${stderr.trim() || `exit code ${exitCode}`}`);
  }

  return parsed;
}

function classifyPowerShellCommand(command: PowerShellCommandAst): ShellFinding[] {
  if (command.name === null || command.elements.length === 0) {
    return [{
      command: command.elements.join(' ').slice(0, 200),
      kind: 'powershell.dynamic-command',
      risk: 'unknown',
      reason: '动态命令名无法静态确认安全',
    }];
  }

  const rawName = command.name.split('\\').at(-1) ?? command.name;
  const name = win32.basename(rawName).replace(/\.exe$/i, '').toLowerCase();
  const canonicalName = POWERSHELL_ALIASES[name] ?? name;
  const commandText = [canonicalName, ...command.elements.slice(1)].join(' ');
  const danger = POWERSHELL_DANGEROUS[canonicalName];
  const registryAction = command.elements[1]?.replace(/^['"]|['"]$/g, '').toLowerCase();

  if (canonicalName === 'reg' && registryAction && REGISTRY_MUTATION_ACTIONS.has(registryAction)) {
    return [{
      command: commandText.slice(0, 200),
      kind: 'sys.config',
      risk: 'dangerous',
      reason: '会修改 Windows 注册表',
    }];
  }

  if (danger) {
    return [{
      command: commandText.slice(0, 200),
      kind: danger.kind,
      risk: 'dangerous',
      reason: danger.reason,
    }];
  }

  return analyzeShellCommand(commandText).findings;
}

function aggregate(findings: ShellFinding[]): ShellRisk {
  if (findings.some((finding) => finding.risk === 'dangerous')) return 'dangerous';
  if (findings.some((finding) => finding.risk === 'unknown')) return 'unknown';
  return 'safe';
}

function runPowerShellParser(command: string): Promise<PowerShellAstSummary> {
  const encoded = Buffer.from(POWERSHELL_PARSER, 'utf16le').toString('base64');
  const parser = spawn(
    windowsSystemPath('WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let outputExceeded = false;
    const timer = setTimeout(() => {
      timedOut = true;
      parser.kill('SIGKILL');
    }, PARSER_TIMEOUT_MS);

    parser.stdout.setEncoding('utf8');
    parser.stderr.setEncoding('utf8');
    parser.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_PARSER_OUTPUT) {
        outputExceeded = true;
        parser.kill('SIGKILL');
      }
    });
    parser.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_PARSER_OUTPUT) stderr += chunk;
    });
    parser.stdin.on('error', () => undefined);
    parser.once('error', (error) => {
      clearTimeout(timer);
      reject(new ToolError(`could not start PowerShell AST parser: ${error.message}`));
    });
    parser.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new ToolError('PowerShell AST parser timed out'));
        return;
      }
      if (outputExceeded) {
        reject(new ToolError('PowerShell AST parser output exceeded the limit'));
        return;
      }

      try {
        resolve(parsePowerShellAstResponse(stdout, code, stderr));
      } catch (error) {
        reject(error);
      }
    });
    parser.stdin.end(command, 'utf8');
  });
}

function isPowerShellAstSummary(value: unknown): value is PowerShellAstSummary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record['errors']) &&
    record['errors'].every((item) => typeof item === 'string') &&
    Array.isArray(record['commands']) &&
    record['commands'].every(isPowerShellCommandAst) &&
    typeof record['hasFileRedirection'] === 'boolean'
  );
}

function isPowerShellCommandAst(value: unknown): value is PowerShellCommandAst {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (typeof record['name'] === 'string' || record['name'] === null) &&
    Array.isArray(record['elements']) &&
    record['elements'].every((item) => typeof item === 'string')
  );
}
