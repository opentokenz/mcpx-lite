/**
 * Shell 命令风险分析：识别只读命令与明确危险命令。
 *
 * 目标不是完整解释 Shell 语义；无法静态确认的构造和未列入规则的命令标记为 unknown，
 * shell 工具只对 dangerous 要求审批。这里仅做保守的顶层拆分与 tokenise。
 */

export type ShellRisk = 'safe' | 'dangerous' | 'unknown';

export interface ShellFinding {
  /** 触发判定的子命令原文（已 trim，可能被截断） */
  command: string;
  /** 稳定标识，用于文案 / 日志 / 测试，例如 `git.commit`、`shell.redirect` */
  kind: string;
  risk: ShellRisk;
  reason: string;
}

export interface ShellRiskAnalysis {
  risk: ShellRisk;
  findings: ShellFinding[];
}

const MAX_FINDING_COMMAND = 200;
/** ponytail: 限制不可信命令的递归分析深度；需要支持更深嵌套时改为显式栈。 */
const MAX_SHELL_WRAPPER_DEPTH = 8;

interface RiskRule {
  kind: string;
  reason: string;
}

const UNKNOWN_INTERPRETER: RiskRule = {
  kind: 'shell.interpreter',
  reason: '解释器/包装命令可以执行任意代码，无法静态确认安全',
};

const UNKNOWN_UNLISTED: RiskRule = {
  kind: 'unknown',
  reason: '未列入只读白名单的命令，无法证明不会产生副作用',
};

/** 只读命令：任何参数都不会写文件、不会执行外部代码（写路径由重定向检查兜住）。 */
const SAFE_READONLY: Record<string, RiskRule> = {
  pwd: { kind: 'unix.pwd', reason: '只打印当前工作目录' },
  ls: { kind: 'unix.ls', reason: '只读目录列表' },
  cat: { kind: 'unix.cat', reason: '只读取并输出文件内容' },
  head: { kind: 'unix.head', reason: '只读取文件开头' },
  tail: { kind: 'unix.tail', reason: '只读取文件结尾' },
  wc: { kind: 'unix.wc', reason: '只统计行数/字节数' },
  nl: { kind: 'unix.nl', reason: '只输出带行号的内容' },
  cut: { kind: 'unix.cut', reason: '只做文本切片输出' },
  tr: { kind: 'unix.tr', reason: '只做字符转换输出' },
  uniq: { kind: 'unix.uniq', reason: '只做去重输出' },
  od: { kind: 'unix.od', reason: '只做字节转储输出' },
  diff: { kind: 'unix.diff', reason: '只比较文件差异' },
  cmp: { kind: 'unix.cmp', reason: '只比较文件差异' },
  grep: { kind: 'unix.grep', reason: '只做只读模式匹配' },
  echo: { kind: 'unix.echo', reason: '只向标准输出打印文本' },
  printf: { kind: 'unix.printf', reason: '只向标准输出打印文本' },
  cd: { kind: 'unix.cd', reason: '只切换当前 shell 的工作目录' },
  exit: { kind: 'unix.exit', reason: '只结束本次 shell' },
  true: { kind: 'unix.builtin', reason: '内置命令，无副作用' },
  false: { kind: 'unix.builtin', reason: '内置命令，无副作用' },
  test: { kind: 'unix.test', reason: '只做条件判断' },
  '[': { kind: 'unix.test', reason: '只做条件判断' },
  sleep: { kind: 'unix.sleep', reason: '只等待指定时间' },
  whoami: { kind: 'unix.identity', reason: '只打印当前用户' },
  id: { kind: 'unix.identity', reason: '只打印当前用户与组' },
  printenv: { kind: 'unix.env', reason: '只打印环境变量' },
  date: { kind: 'unix.info', reason: '只打印时间信息' },
  uname: { kind: 'unix.info', reason: '只打印系统信息' },
  stat: { kind: 'unix.info', reason: '只打印文件元信息' },
  du: { kind: 'unix.info', reason: '只统计磁盘占用' },
  df: { kind: 'unix.info', reason: '只统计磁盘空间' },
  which: { kind: 'unix.lookup', reason: '只查找命令路径' },
  type: { kind: 'unix.lookup', reason: '只解析命令类型' },
  realpath: { kind: 'unix.lookup', reason: '只解析真实路径' },
  readlink: { kind: 'unix.lookup', reason: '只解析链接目标' },
  basename: { kind: 'unix.lookup', reason: '只处理路径字符串' },
  dirname: { kind: 'unix.lookup', reason: '只处理路径字符串' },
  cksum: { kind: 'unix.hash', reason: '只计算校验和' },
  md5sum: { kind: 'unix.hash', reason: '只计算摘要' },
  sha256sum: { kind: 'unix.hash', reason: '只计算摘要' },
  shasum: { kind: 'unix.hash', reason: '只计算摘要' },
};

/** 危险命令：明确会写文件、改系统、联网或执行任意代码。 */
const DANGEROUS: Record<string, RiskRule> = {
  rm: { kind: 'fs.rm', reason: '会删除文件或目录' },
  rmdir: { kind: 'fs.rm', reason: '会删除目录' },
  mv: { kind: 'fs.mv', reason: '会移动或重命名文件' },
  cp: { kind: 'fs.cp', reason: '会复制或覆盖文件' },
  install: { kind: 'fs.cp', reason: '会复制文件到目标路径' },
  touch: { kind: 'fs.touch', reason: '会创建文件或更新时间戳' },
  mkdir: { kind: 'fs.mkdir', reason: '会创建目录' },
  mktemp: { kind: 'fs.mkdir', reason: '会创建临时文件或目录' },
  chmod: { kind: 'fs.chmod', reason: '会修改文件权限' },
  chown: { kind: 'fs.chown', reason: '会修改文件属主' },
  chgrp: { kind: 'fs.chown', reason: '会修改文件属组' },
  ln: { kind: 'fs.link', reason: '会创建硬链接或符号链接' },
  truncate: { kind: 'fs.write', reason: '会截断或扩展文件' },
  tee: { kind: 'fs.write', reason: '会写入文件' },
  dd: { kind: 'fs.write', reason: '会按字节写入文件或设备' },
  shred: { kind: 'fs.write', reason: '会覆盖并删除文件' },
  sudo: { kind: 'priv.sudo', reason: '会以更高权限执行命令' },
  su: { kind: 'priv.sudo', reason: '会切换用户身份' },
  kill: { kind: 'proc.kill', reason: '会终止进程' },
  pkill: { kind: 'proc.kill', reason: '会按名字终止进程' },
  killall: { kind: 'proc.kill', reason: '会按名字终止进程' },
  curl: { kind: 'net.fetch', reason: '会发起网络请求' },
  wget: { kind: 'net.fetch', reason: '会下载文件' },
  nc: { kind: 'net.fetch', reason: '会建立网络连接' },
  ncat: { kind: 'net.fetch', reason: '会建立网络连接' },
  ssh: { kind: 'net.fetch', reason: '会连接远端主机并执行命令' },
  scp: { kind: 'net.fetch', reason: '会向远端复制文件' },
  sftp: { kind: 'net.fetch', reason: '会向远端传输文件' },
  rsync: { kind: 'net.fetch', reason: '会同步并覆盖文件' },
  'docker-compose': { kind: 'infra.apply', reason: '会变更容器/服务状态' },
  shutdown: { kind: 'sys.power', reason: '会关闭或重启机器' },
  reboot: { kind: 'sys.power', reason: '会重启机器' },
  halt: { kind: 'sys.power', reason: '会关闭机器' },
  mount: { kind: 'sys.mount', reason: '会挂载文件系统' },
  umount: { kind: 'sys.mount', reason: '会卸载文件系统' },
  crontab: { kind: 'sys.config', reason: '会修改定时任务' },
  launchctl: { kind: 'sys.service', reason: '会变更系统服务' },
  systemctl: { kind: 'sys.service', reason: '会变更系统服务' },
  service: { kind: 'sys.service', reason: '会变更系统服务' },
  defaults: { kind: 'sys.config', reason: '会修改系统/应用配置' },
  diskutil: { kind: 'sys.disk', reason: '会变更磁盘或卷' },
  hdiutil: { kind: 'sys.disk', reason: '会挂载或转换磁盘映像' },
};

/** 明确要求审批的危险命令族；匹配解析后的可执行文件名开头。 */
const DANGEROUS_COMMAND_PREFIXES: Record<string, RiskRule> = {
  rm: DANGEROUS.rm,
  mkfs: { kind: 'sys.disk', reason: '会格式化文件系统' },
  wipefs: { kind: 'sys.disk', reason: '会擦除文件系统签名' },
  srm: { kind: 'fs.rm', reason: '会安全删除文件' },
  fdisk: { kind: 'sys.disk', reason: '会变更磁盘分区' },
  sfdisk: { kind: 'sys.disk', reason: '会变更磁盘分区' },
  parted: { kind: 'sys.disk', reason: '会变更磁盘分区' },
  poweroff: { kind: 'sys.power', reason: '会关闭机器' },
  pkexec: { kind: 'priv.sudo', reason: '会以更高权限执行命令' },
  doas: { kind: 'priv.sudo', reason: '会以更高权限执行命令' },
  iptables: { kind: 'sys.firewall', reason: '会修改防火墙规则' },
  ip6tables: { kind: 'sys.firewall', reason: '会修改防火墙规则' },
  nft: { kind: 'sys.firewall', reason: '会修改防火墙规则' },
  chattr: { kind: 'fs.chmod', reason: '会修改文件属性' },
  setfacl: { kind: 'fs.chmod', reason: '会修改文件访问控制列表' },
  restart: { kind: 'sys.service', reason: '会重启系统或服务' },
  shutdown: DANGEROUS.shutdown,
  reboot: DANGEROUS.reboot,
};

/** 通过包管理器 / 构建工具 / 云 CLI 执行的命令：可能装依赖、发请求、改远端。 */
const DANGEROUS_TOOLS: Record<string, RiskRule> = {
  npm: { kind: 'pkg.manage', reason: 'npm 会安装/发布依赖或执行任意脚本' },
  yarn: { kind: 'pkg.manage', reason: 'yarn 会安装/发布依赖或执行任意脚本' },
  bun: { kind: 'pkg.manage', reason: 'bun 会安装依赖或执行任意脚本' },
  pip: { kind: 'pkg.manage', reason: 'pip 会安装/卸载 Python 依赖' },
  pip3: { kind: 'pkg.manage', reason: 'pip 会安装/卸载 Python 依赖' },
  brew: { kind: 'pkg.manage', reason: 'brew 会安装/升级/卸载软件包' },
  gem: { kind: 'pkg.manage', reason: 'gem 会安装/卸载 Ruby 依赖' },
  apt: { kind: 'pkg.manage', reason: 'apt 会变更系统软件包' },
  'apt-get': { kind: 'pkg.manage', reason: 'apt-get 会变更系统软件包' },
  yum: { kind: 'pkg.manage', reason: 'yum 会变更系统软件包' },
  dnf: { kind: 'pkg.manage', reason: 'dnf 会变更系统软件包' },
  pacman: { kind: 'pkg.manage', reason: 'pacman 会变更系统软件包' },
  snap: { kind: 'pkg.manage', reason: 'snap 会变更系统软件包' },
  cargo: { kind: 'pkg.manage', reason: 'cargo 会构建/安装/发布 crate' },
  go: { kind: 'pkg.manage', reason: 'go 会构建/安装/下载依赖' },
  make: { kind: 'build.run', reason: 'make 会执行 Makefile 中的任意命令' },
  cmake: { kind: 'build.run', reason: 'cmake 会生成构建文件并可能执行外部工具' },
  mvn: { kind: 'build.run', reason: 'mvn 会下载依赖、执行插件与构建' },
  gradle: { kind: 'build.run', reason: 'gradle 会执行构建脚本与插件' },
  docker: { kind: 'infra.apply', reason: 'docker 会变更容器、镜像或卷' },
  kubectl: { kind: 'infra.apply', reason: 'kubectl 会变更集群资源' },
  helm: { kind: 'infra.apply', reason: 'helm 会变更集群发布' },
  terraform: { kind: 'infra.apply', reason: 'terraform 会变更云上真实资源' },
  aws: { kind: 'infra.apply', reason: 'aws 会变更云端资源' },
  gcloud: { kind: 'infra.apply', reason: 'gcloud 会变更云端资源' },
  az: { kind: 'infra.apply', reason: 'az 会变更云端资源' },
  gh: { kind: 'net.publish', reason: 'gh 会变更远端仓库/发布/PR' },
  heroku: { kind: 'net.publish', reason: 'heroku 会变更远端应用' },
  vercel: { kind: 'net.publish', reason: 'vercel 会发布或变更远端项目' },
  netlify: { kind: 'net.publish', reason: 'netlify 会发布或变更远端项目' },
  wrangler: { kind: 'net.publish', reason: 'wrangler 会发布或变更远端 Worker' },
  osascript: { kind: 'sys.script', reason: 'osascript 会操作本机应用与系统' },
  xcodebuild: { kind: 'build.run', reason: 'xcodebuild 会构建并可能执行脚本阶段' },
  gpg: { kind: 'crypto.key', reason: 'gpg 会读写密钥与文件' },
  openssl: { kind: 'crypto.key', reason: 'openssl 会生成密钥、写文件或建立连接' },
  tar: { kind: 'archive.write', reason: 'tar 会解包并覆盖文件' },
  unzip: { kind: 'archive.write', reason: 'unzip 会解包并覆盖文件' },
  zip: { kind: 'archive.write', reason: 'zip 会创建/更新压缩包' },
  gzip: { kind: 'archive.write', reason: 'gzip 会重写或删除文件' },
  gunzip: { kind: 'archive.write', reason: 'gunzip 会重写文件' },
  bzip2: { kind: 'archive.write', reason: 'bzip2 会重写文件' },
  xz: { kind: 'archive.write', reason: 'xz 会重写文件' },
  '7z': { kind: 'archive.write', reason: '7z 会解包并覆盖文件' },
};

/** 支持静态提取 `-c` 命令字符串的 shell 包装器。 */
const SHELL_COMMAND_WRAPPERS = new Set(['bash', 'sh', 'zsh']);
const SHELL_OPTIONS_WITH_ARGUMENTS = new Set(['-o', '-O', '--rcfile', '--init-file']);

/** 其它解释器 / 包装器无法静态分析时标记为 unknown。 */
const INTERPRETERS = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'csh',
  'tcsh',
  'node',
  'nodejs',
  'deno',
  'tsx',
  'ts-node',
  'npx',
  'pnpx',
  'python',
  'python2',
  'python3',
  'ruby',
  'perl',
  'php',
  'lua',
  'Rscript',
  'env',
  'xargs',
  'eval',
  'source',
  '.',
  'nohup',
  'timeout',
  'watch',
  'screen',
  'tmux',
  'ssh-keygen',
]);

const GIT_SAFE: Record<string, RiskRule> = {
  status: { kind: 'git.status', reason: '只读取工作区与索引状态' },
  diff: { kind: 'git.diff', reason: '只输出差异' },
  log: { kind: 'git.log', reason: '只读取提交历史' },
  show: { kind: 'git.show', reason: '只输出提交内容' },
};

const GIT_DANGEROUS: Record<string, RiskRule> = {
  commit: { kind: 'git.commit', reason: '会创建本地 Git 提交' },
  push: { kind: 'git.push', reason: '会把提交推送到远端仓库' },
  reset: { kind: 'git.reset', reason: '会移动分支指针并可能丢弃工作区/索引改动' },
  clean: { kind: 'git.clean', reason: '会删除未跟踪文件' },
  restore: { kind: 'git.restore', reason: '会覆盖工作区或索引文件' },
  'cherry-pick': { kind: 'git.cherry-pick', reason: '会把提交应用到当前分支' },
  revert: { kind: 'git.revert', reason: '会创建反向提交' },
  am: { kind: 'git.am', reason: '会应用邮件补丁并修改工作区' },
  rm: { kind: 'git.rm', reason: '会删除 Git 跟踪的文件' },
  submodule: { kind: 'git.submodule', reason: '会修改子模块配置与目录' },
  worktree: { kind: 'git.worktree', reason: '会创建或删除工作树' },
  lfs: { kind: 'git.lfs', reason: '会修改 Git LFS 状态与文件' },
  'filter-branch': { kind: 'git.filter-branch', reason: '会重写仓库历史' },
  gc: { kind: 'git.gc', reason: '会清理并重写 Git 仓库对象' },
  prune: { kind: 'git.prune', reason: '会删除不可达对象' },
  repack: { kind: 'git.repack', reason: '会重写 Git 包文件' },
  'update-ref': { kind: 'git.update-ref', reason: '会更新 Git 引用' },
  'symbolic-ref': { kind: 'git.symbolic-ref', reason: '会更新 Git 引用' },
  maintenance: { kind: 'git.maintenance', reason: '会执行仓库维护并可能重写对象' },
};

const GIT_DANGEROUS_PREFIXES = Object.keys(GIT_DANGEROUS);

/** 允许的 `pnpm <script>`：仅项目约定的只读验证脚本。 */
const PNPM_SCRIPTS = new Set(['test', 'typecheck', 'lint']);

/** pnpm 中明确会改依赖/发布/执行任意代码的子命令。 */
const PNPM_DANGEROUS = new Set([
  'add',
  'install',
  'i',
  'remove',
  'rm',
  'uninstall',
  'update',
  'up',
  'upgrade',
  'publish',
  'link',
  'unlink',
  'patch',
  'patch-commit',
  'dlx',
  'exec',
  'create',
  'init',
  'import',
  'deploy',
  'prune',
  'rebuild',
  'rebuild--pending',
]);

/** 需要额外参数守卫的只读命令：特定参数会写文件或执行外部命令。 */
const READONLY_GUARDS: Array<{
  name: string;
  rule: RiskRule;
  /** 命中即判危险的参数（完整匹配或前缀匹配） */
  deny: string[];
  denyPrefixes: string[];
}> = [
  {
    name: 'rg',
    rule: { kind: 'unix.rg', reason: '只做只读模式匹配' },
    deny: [],
    denyPrefixes: ['--pre', '--hostname-bin'],
  },
  {
    name: 'sort',
    rule: { kind: 'unix.sort', reason: '只做排序输出' },
    deny: ['-o'],
    denyPrefixes: ['--output'],
  },
  {
    name: 'find',
    rule: { kind: 'unix.find', reason: '只遍历并匹配文件' },
    deny: ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'],
    denyPrefixes: [],
  },
];

/**
 * 分析整条 Shell 命令：顶层拆分成子命令，逐段判定后聚合。
 * 聚合规则：任一 dangerous → dangerous；否则任一 unknown → unknown；全部 safe → safe。
 */
export function analyzeShellCommand(command: string): ShellRiskAnalysis {
  return analyzeShellCommandAtDepth(command, 0);
}

function analyzeShellCommandAtDepth(command: string, wrapperDepth: number): ShellRiskAnalysis {
  const text = typeof command === 'string' ? command : '';
  const findings = splitTopLevel(text).flatMap(({ command: segment, background }) => {
    const result = segment ? analyzeSegment(segment, wrapperDepth) : [];
    if (background) {
      result.push(finding(segment, 'shell.background', 'unknown', '后台执行无法静态确认安全'));
    }
    return result;
  });

  if (findings.length === 0) {
    return { risk: 'unknown', findings: [finding(text.trim(), 'unknown', 'unknown', '空命令无法确认安全')] };
  }

  return { risk: aggregate(findings), findings };
}

/** 卡片/确认文案里展示的「触发原因」：取风险最高的一条 finding。 */
export function summarizeRisk(analysis: ShellRiskAnalysis): { kind: string; reason: string; command: string } {
  const ordered = [...analysis.findings].sort((a, b) => rank(b.risk) - rank(a.risk));
  const top = ordered[0]!;
  return { kind: top.kind, reason: top.reason, command: top.command };
}

function rank(risk: ShellRisk): number {
  return risk === 'dangerous' ? 2 : risk === 'unknown' ? 1 : 0;
}

function aggregate(findings: ShellFinding[]): ShellRisk {
  if (findings.some((finding) => finding.risk === 'dangerous')) return 'dangerous';
  if (findings.some((finding) => finding.risk === 'unknown')) return 'unknown';
  return 'safe';
}

function finding(command: string, kind: string, risk: ShellRisk, reason: string): ShellFinding {
  const trimmed = command.trim();
  const text = trimmed.length > MAX_FINDING_COMMAND ? `${trimmed.slice(0, MAX_FINDING_COMMAND)}…` : trimmed;
  return { command: text, kind, risk, reason };
}

/**
 * 顶层拆分：在未被引号包裹的位置按 `&&`、`||`、`&`、`;`、`|`、换行切分。
 * 单个 `&` 标记前一段为后台命令；其它不支持的构造留给逐段检查。
 */
function splitTopLevel(command: string): { command: string; background: boolean }[] {
  const parts: { command: string; background: boolean }[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let index = 0;

  while (index < command.length) {
    const char = command[index]!;

    if (quote !== null) {
      if (quote === '"' && char === '\\') {
        // 双引号内的转义：连同下一个字符一起保留
        current += char;
        if (index + 1 < command.length) current += command[index + 1]!;
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      current += char;
      index += 1;
      continue;
    }

    if (char === '\\') {
      current += char;
      if (index + 1 < command.length) current += command[index + 1]!;
      index += 2;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      index += 1;
      continue;
    }

    if (char === '&' && command[index + 1] === '&') {
      parts.push({ command: current, background: false });
      current = '';
      index += 2;
      continue;
    }

    if (char === '&') {
      parts.push({ command: current, background: true });
      current = '';
      index += 1;
      continue;
    }

    if (char === '|' && command[index + 1] === '|') {
      parts.push({ command: current, background: false });
      current = '';
      index += 2;
      continue;
    }

    if (char === '|' || char === ';' || char === '\n') {
      parts.push({ command: current, background: false });
      current = '';
      index += 1;
      continue;
    }

    current += char;
    index += 1;
  }

  parts.push({ command: current, background: false });
  return parts
    .map((part) => ({ command: part.command.trim(), background: part.background }))
    .filter((part) => part.command.length > 0 || part.background);
}

/** 危险命令优先识别，避免参数里的动态语法掩盖显式危险命令。 */
function analyzeSegment(segment: string, wrapperDepth: number): ShellFinding[] {
  const tokens = tokenize(segment);
  if (tokens && tokens.length > 0) {
    const commandName = tokens[0]!.slice(tokens[0]!.lastIndexOf('/') + 1);
    const script = shellCommandArgument(commandName, tokens);
    if (script !== null && wrapperDepth < MAX_SHELL_WRAPPER_DEPTH) {
      const wrapped = analyzeShellCommandAtDepth(script, wrapperDepth + 1);
      if (wrapped.risk === 'dangerous') return wrapped.findings;
    }
  }

  const classified = tokens && tokens.length > 0 ? classifyShellCommand(segment, tokens) : null;
  if (classified?.some((item) => item.risk === 'dangerous')) return classified;

  const syntax = detectUnsafeSyntax(segment);
  if (syntax) return [syntax];

  return classified ?? [finding(segment, 'shell.unparsable', 'unknown', '无法可靠解析此段命令')];
}

/** 提取 bash/sh/zsh 的 `-c` 命令字符串；不执行或展开该字符串。 */
function shellCommandArgument(commandName: string, tokens: string[]): string | null {
  if (!SHELL_COMMAND_WRAPPERS.has(commandName)) return null;

  let index = 1;
  while (index < tokens.length) {
    const option = tokens[index]!;
    if (option === '-c' || option === '--command') return tokens[index + 1] ?? null;
    if (SHELL_OPTIONS_WITH_ARGUMENTS.has(option)) {
      index += 2;
      continue;
    }
    if (option === '--') return null;
    if (option.startsWith('--')) {
      index += 1;
      continue;
    }
    if (option.startsWith('-')) {
      if (option.slice(1).includes('c')) return tokens[index + 1] ?? null;
      index += 1;
      continue;
    }
    return null;
  }

  return null;
}

/** 无法静态解释的 Shell 构造：直接 unknown，不做任何「可能安全」的推断。 */
function detectUnsafeSyntax(segment: string): ShellFinding | null {
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;

    if (char === '\\' && quote !== "'") {
      index += 1;
      continue;
    }

    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }

    if (quote === '"') {
      if (char === '"') {
        quote = null;
        continue;
      }
      if (char === '`') return finding(segment, 'shell.substitution', 'unknown', '反引号命令替换无法静态确认安全');
      if (char === '$') {
        const next = segment[index + 1];
        if (next === '(') return finding(segment, 'shell.substitution', 'unknown', '命令替换无法静态确认安全');
        return finding(segment, 'shell.variable', 'unknown', '变量展开无法静态确认安全');
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '`') return finding(segment, 'shell.substitution', 'unknown', '反引号命令替换无法静态确认安全');
    if (char === '$') {
      const next = segment[index + 1];
      if (next === '(') return finding(segment, 'shell.substitution', 'unknown', '命令替换无法静态确认安全');
      if (next === "'" || next === '"') {
        return finding(segment, 'shell.dynamic', 'unknown', 'ANSI-C 引号无法静态确认安全');
      }
      return finding(segment, 'shell.variable', 'unknown', '变量展开无法静态确认安全');
    }
    if (char === '>' || char === '<') {
      return finding(segment, 'shell.redirect', 'unknown', '重定向会写文件或改变输入来源');
    }
    if (char === '(' || char === ')') {
      return finding(segment, 'shell.subshell', 'unknown', '子 shell 或命令分组无法静态确认安全');
    }
    if (char === '{' || char === '}') {
      return finding(segment, 'shell.grouping', 'unknown', '花括号分组/展开无法静态确认安全');
    }
    if (char === '&') return finding(segment, 'shell.background', 'unknown', '后台执行无法静态确认安全');
  }

  return null;
}

/** 保守 tokenise：尊重单/双引号和转义；无法闭合引号时返回 null。 */
function tokenize(segment: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let hasContent = false;
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;

    if (quote === "'") {
      if (char === "'") {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (quote === '"') {
      if (char === '"') {
        quote = null;
        continue;
      }
      if (char === '\\') {
        const next = segment[index + 1];
        if (next === undefined) return null;
        current += next;
        index += 1;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '\\') {
      const next = segment[index + 1];
      if (next === undefined) return null;
      current += next;
      hasContent = true;
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      hasContent = true;
      continue;
    }

    if (char === ' ' || char === '\t') {
      if (hasContent) {
        tokens.push(current);
        current = '';
        hasContent = false;
      }
      continue;
    }

    current += char;
    hasContent = true;
  }

  if (quote !== null) return null;
  if (hasContent) tokens.push(current);
  return tokens;
}

function classifyShellCommand(segment: string, tokens: string[]): ShellFinding[] {
  const name = tokens[0]!;
  const commandName = name.slice(name.lastIndexOf('/') + 1);
  const rest = tokens.slice(1);

  if (name.includes('=')) {
    return [finding(segment, 'shell.assignment', 'unknown', '变量赋值或环境变量前缀无法静态确认安全')];
  }

  const prefixRule = Object.entries(DANGEROUS_COMMAND_PREFIXES).find(([prefix]) => commandName.startsWith(prefix))?.[1];
  if (prefixRule) return [finding(segment, prefixRule.kind, 'dangerous', prefixRule.reason)];

  const danger = DANGEROUS[commandName] ?? DANGEROUS_TOOLS[commandName];
  if (danger) return [finding(segment, danger.kind, 'dangerous', danger.reason)];

  if (commandName === 'git') {
    const gitFinding = classifyGit(segment, rest);
    if (!name.includes('/') || gitFinding.risk === 'dangerous') return [gitFinding];
  }

  if (name.includes('/')) {
    return [finding(segment, 'shell.path', 'unknown', '非标准路径命令无法静态确认安全')];
  }

  if (name === 'pnpm') return [classifyPnpm(segment, rest)];
  if (name === 'vitest') return [classifyVitest(segment, rest)];
  if (name === 'tsc') return [classifyTsc(segment, rest)];

  const guard = READONLY_GUARDS.find((candidate) => candidate.name === name);
  if (guard) {
    const denied = rest.find(
      (arg) => guard.deny.includes(arg) || guard.denyPrefixes.some((prefix) => arg.startsWith(prefix)),
    );
    if (denied) {
      return [
        finding(segment, 'fs.write', 'dangerous', `「${name} ${denied}」会写文件或执行外部命令，需要确认`),
      ];
    }
    return [finding(segment, guard.rule.kind, 'safe', guard.rule.reason)];
  }

  const safe = SAFE_READONLY[name];
  if (safe) return [finding(segment, safe.kind, 'safe', safe.reason)];

  if (INTERPRETERS.has(name)) return [finding(segment, UNKNOWN_INTERPRETER.kind, 'unknown', UNKNOWN_INTERPRETER.reason)];

  return [finding(segment, UNKNOWN_UNLISTED.kind, 'unknown', UNKNOWN_UNLISTED.reason)];
}

function classifyGit(segment: string, rest: string[]): ShellFinding {
  const sub = rest[0];
  const args = rest.slice(1);

  if (!sub || sub.startsWith('-')) {
    return finding(segment, 'git.unresolved', 'unknown', '缺少可识别的 Git 子命令（或使用了全局参数），无法确认安全');
  }

  const safe = GIT_SAFE[sub];
  if (safe) {
    const denied = rest.slice(1).find((arg) => arg === '-o' || arg.startsWith('--output'));
    if (denied) {
      return finding(segment, 'fs.write', 'dangerous', `「git ${sub} ${denied}」会把输出写入文件，需要确认`);
    }
    return finding(segment, safe.kind, 'safe', safe.reason);
  }

  if (
    sub === 'checkout' &&
    args.some((arg) => ['--', '-f', '--force', '-B', '-m', '--merge', '-p', '--patch', '--ours', '--theirs'].includes(arg))
  ) {
    return finding(segment, 'git.checkout.restore', 'dangerous', '会覆盖或丢弃工作区文件中的本地修改');
  }
  if (sub === 'switch' && args.some((arg) => ['-f', '--force', '-C', '--discard-changes'].includes(arg))) {
    return finding(segment, 'git.switch.discard', 'dangerous', '会覆盖或丢弃工作区文件中的本地修改');
  }
  if (sub === 'stash' && ['drop', 'clear'].includes(args[0] ?? '')) {
    return finding(segment, 'git.stash.delete', 'dangerous', '会删除 stash 中保存的工作区改动');
  }
  if (sub === 'branch' && args.some((arg) => ['-D', '-f', '-M', '--force'].includes(arg))) {
    return finding(segment, 'git.branch.force-delete', 'dangerous', '可能丢失未合并分支的提交引用');
  }
  if (sub === 'tag' && args.some((arg) => ['-f', '--force'].includes(arg))) {
    return finding(segment, 'git.tag.force-update', 'dangerous', '会覆盖现有标签引用');
  }
  if (sub === 'mv' && args.some((arg) => ['-f', '--force'].includes(arg))) {
    return finding(segment, 'git.mv.overwrite', 'dangerous', '会覆盖目标文件');
  }
  if (sub === 'apply' && args.includes('--unsafe-paths')) {
    return finding(segment, 'git.apply.unsafe-paths', 'dangerous', '允许补丁写入仓库目录之外的路径');
  }

  const dangerousPrefix = GIT_DANGEROUS_PREFIXES.find((prefix) => sub.startsWith(prefix));
  if (dangerousPrefix) {
    const danger = GIT_DANGEROUS[dangerousPrefix]!;
    return finding(segment, danger.kind, 'dangerous', danger.reason);
  }

  return finding(segment, 'git.unresolved', 'unknown', `git ${sub} 不在只读白名单内，无法确认安全`);
}

function classifyPnpm(segment: string, rest: string[]): ShellFinding {
  const sub = rest[0];

  if (!sub) return finding(segment, 'pkg.manage', 'dangerous', '直接执行 pnpm 会安装依赖并执行项目脚本');

  if (PNPM_SCRIPTS.has(sub)) {
    return finding(segment, `pkg.${sub}`, 'safe', `只运行项目约定的 ${sub} 验证脚本`);
  }

  if (PNPM_DANGEROUS.has(sub) || sub.startsWith('-')) {
    return finding(segment, 'pkg.manage', 'dangerous', `pnpm ${sub} 会变更依赖、发布产物或执行任意代码`);
  }

  return finding(segment, 'pkg.manage', 'dangerous', `pnpm ${sub} 会执行项目脚本或变更依赖`);
}

function classifyVitest(segment: string, rest: string[]): ShellFinding {
  if (rest[0] === 'run') return finding(segment, 'test.vitest', 'safe', '只以 run 模式执行测试并退出');
  return finding(segment, 'test.vitest', 'unknown', 'vitest 未指定 run，可能进入 watch 模式并长期占用终端');
}

function classifyTsc(segment: string, rest: string[]): ShellFinding {
  if (rest.some((arg) => arg === '-b' || arg === '--build')) {
    return finding(segment, 'build.tsc', 'dangerous', 'tsc --build 会写入增量构建产物');
  }
  if (rest.includes('--noEmit')) {
    return finding(segment, 'typecheck.tsc', 'safe', 'tsc --noEmit 只做类型检查，不写文件');
  }
  return finding(segment, 'build.tsc', 'dangerous', 'tsc 未加 --noEmit 会写入编译产物');
}
