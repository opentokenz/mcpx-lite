import { describe, expect, it } from 'vitest';
import { analyzeShellCommand, summarizeRisk } from '../src/risk.js';

const riskOf = (command: string) => analyzeShellCommand(command).risk;
const kinds = (command: string) => analyzeShellCommand(command).findings.map((finding) => finding.kind);

describe('analyzeShellCommand - safe 单命令', () => {
  it('基础只读命令直接判 safe', () => {
    for (const command of [
      'pwd',
      'ls -la',
      'cat package.json',
      'head -20 README.md',
      'tail -5 .gitignore',
      'rg "tool" src',
      "grep -rn 'session' src",
      "find . -name '*.ts'",
      'wc -l src/index.ts',
      'git status',
      'git status --short',
      'git diff',
      'git diff --stat',
      'git log --oneline -5',
      'git show HEAD',
      'pnpm test',
      'pnpm typecheck',
      'pnpm lint',
      'vitest run',
      'tsc --noEmit',
    ]) {
      expect(riskOf(command), command).toBe('safe');
    }
  });

  it('每个 safe 子命令都带 kind / reason 的 finding', () => {
    const analysis = analyzeShellCommand('git status');

    expect(analysis.findings).toHaveLength(1);
    expect(analysis.findings[0]).toMatchObject({ risk: 'safe', kind: 'git.status', command: 'git status' });
    expect(analysis.findings[0]?.reason).toBeTruthy();
  });

  it('多个 safe 子命令用 && / || / ; / 管道连接仍然 safe', () => {
    expect(riskOf('pnpm typecheck && pnpm test')).toBe('safe');
    expect(riskOf('git status && git diff')).toBe('safe');
    expect(riskOf('git status | cat')).toBe('safe');
    expect(riskOf('ls; pwd')).toBe('safe');
    expect(riskOf('cat a.txt || cat b.txt')).toBe('safe');
    expect(riskOf('ls -1\necho second-line')).toBe('safe');
  });

  it('引号里的连接符不拆分，也不误判', () => {
    expect(riskOf(`echo "a && b | c; d"`)).toBe('safe');
    expect(riskOf(`echo 'a&b|c'`)).toBe('safe');
    expect(analyzeShellCommand(`echo 'a&b|c'`).findings).toHaveLength(1);
    expect(riskOf(`rg 'foo|bar' src`)).toBe('safe');
    expect(riskOf(`grep 'a;b' file.txt`)).toBe('safe');
  });
});

describe('analyzeShellCommand - dangerous', () => {
  it('文件系统破坏操作与 Git 高风险命令判 dangerous', () => {
    expect(riskOf('rm -rf dist')).toBe('dangerous');
    expect(riskOf('mv a b')).toBe('dangerous');
    expect(riskOf('cp a b')).toBe('dangerous');
    expect(riskOf('touch gated.txt')).toBe('dangerous');
    expect(riskOf('mkdir -p out')).toBe('dangerous');
    expect(riskOf('chmod +x script.sh')).toBe('dangerous');
    expect(riskOf('git commit -m "msg"')).toBe('dangerous');
    expect(riskOf('git push origin main')).toBe('dangerous');
    expect(riskOf('git reset --hard')).toBe('dangerous');
    expect(riskOf('git clean -fd')).toBe('dangerous');
    expect(riskOf('git restore .')).toBe('dangerous');
    expect(riskOf('pnpm add zod')).toBe('dangerous');
    expect(riskOf('pnpm install')).toBe('dangerous');
    expect(riskOf('curl https://example.com')).toBe('dangerous');
    expect(riskOf('sudo rm file')).toBe('dangerous');
    expect(riskOf('kill 1234')).toBe('dangerous');
  });

  it('可撤回的 Git 本地操作不再标记为 dangerous', () => {
    for (const command of [
      'git add .',
      'git mv old.txt new.txt',
      'git apply change.patch',
      'git fetch origin',
      'git pull --ff-only',
      'git branch feature',
      'git tag v1',
      'git stash push',
      'git merge feature',
      'git rebase main',
      'git switch feature',
      'git checkout feature',
      'git config user.name Ada',
    ]) {
      expect(riskOf(command), command).toBe('unknown');
    }
  });

  it('Git 中会覆盖或丢弃本地改动的形式仍然 dangerous', () => {
    for (const command of [
      'git checkout -- file.txt',
      'git checkout --merge file.txt',
      'git checkout -B main commit',
      'git switch --discard-changes main',
      'git switch -C main',
      'git stash drop stash@{0}',
      'git stash clear',
      'git branch -D unmerged',
      'git branch -f main commit',
      'git branch -M old new',
      'git tag --force release commit',
      'git mv -f old.txt existing.txt',
      'git apply --unsafe-paths patch.diff',
    ]) {
      expect(riskOf(command), command).toBe('dangerous');
    }
  });

  it('git 变更子命令带 git.<sub> 的 kind 与中文原因', () => {
    const analysis = analyzeShellCommand('git commit -m x');
    expect(analysis.findings[0]).toMatchObject({ risk: 'dangerous', kind: 'git.commit' });
    expect(analysis.findings[0]?.reason).toContain('提交');
    expect(summarizeRisk(analysis)).toMatchObject({ kind: 'git.commit' });
  });

  it('find 的写/执行谓词不再算 safe', () => {
    expect(riskOf(`find . -name '*.tmp' -delete`)).toBe('dangerous');
    expect(riskOf('find . -type f -exec rm -f a.txt +')).toBe('dangerous');
    expect(riskOf('find . -name x -fprint out.txt')).toBe('dangerous');
    // 即使 {} 让 Shell 语法无法静态解释，也不能让显式 -exec 危险谓词降为 unknown
    expect(riskOf('find . -exec rm {} \\;')).toBe('dangerous');
  });

  it('其它写文件变体（sort -o / tsc / 重定向目标）不再算 safe', () => {
    expect(riskOf('sort -o out.txt in.txt')).toBe('dangerous');
    expect(riskOf('tsc')).toBe('dangerous');
    expect(riskOf('tsc --build')).toBe('dangerous');
  });

  it('rg --pre 会执行外部命令，判 dangerous', () => {
    expect(riskOf('rg --pre cat pattern')).toBe('dangerous');
  });

  it('危险命令即使参数含变量或重定向仍判 dangerous', () => {
    for (const command of ['rm "$HOME/file"', 'git push "$remote"', 'shutdown > /dev/null']) {
      expect(riskOf(command), command).toBe('dangerous');
    }
  });

  it('危险命令前缀与带路径的危险程序仍判 dangerous', () => {
    for (const command of [
      'mkfs.ext4 /dev/disk0',
      'wipefs-extra /dev/disk0',
      'srm-safe file',
      'fdisk-wrapper /dev/disk0',
      'sfdisk-wrapper /dev/disk0',
      'parted-helper /dev/disk0',
      'poweroff-now',
      'pkexec-helper command',
      'doas-helper command',
      'iptables-helper --flush',
      'ip6tables-helper --flush',
      'nft-helper flush',
      'chattr-helper +i file',
      'setfacl-helper file',
      'restart-service example',
      'shutdown-fast',
      'reboot-now',
      '/bin/rm -rf dist',
      '/usr/bin/git push origin main',
      '/usr/bin/git reset --hard',
      'git push-helper origin main',
      'git reset-hard --hard',
    ]) {
      expect(riskOf(command), command).toBe('dangerous');
    }
  });
});

describe('analyzeShellCommand - mixed 与聚合规则', () => {
  it('safe + dangerous 混合时整体 dangerous', () => {
    const analysis = analyzeShellCommand('git status && git commit -m x');

    expect(analysis.risk).toBe('dangerous');
    expect(analysis.findings.map((finding) => finding.risk)).toEqual(['safe', 'dangerous']);
    expect(analysis.findings[1]).toMatchObject({ kind: 'git.commit', command: 'git commit -m x' });
  });

  it('safe + unknown 混合时整体 unknown', () => {
    expect(riskOf('git status && whatever-custom-tool --flag')).toBe('unknown');
  });

  it('pipeline 每段都要 safe', () => {
    expect(riskOf('git status | cat')).toBe('safe');
    expect(riskOf('git status | tee copy.txt')).toBe('dangerous');
  });

  it('未引用的单个 & 分隔后台命令，并保留危险命令判定', () => {
    const analysis = analyzeShellCommand('rm -rf dist & echo done');

    expect(analysis.risk).toBe('dangerous');
    expect(analysis.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: 'rm -rf dist', kind: 'fs.rm', risk: 'dangerous' }),
        expect.objectContaining({ kind: 'shell.background', risk: 'unknown' }),
      ]),
    );
    expect(riskOf(`echo 'a&b|c'`)).toBe('safe');
  });

  it('dangerous 优先于 unknown', () => {
    expect(riskOf('whatever-custom-tool && rm -rf dist')).toBe('dangerous');
  });
});

describe('analyzeShellCommand - 复杂语法 fail closed', () => {
  it('命令替换 / 反引号 / 变量展开 / ANSI-C 引号判 unknown', () => {
    expect(riskOf('echo $(git status)')).toBe('unknown');
    expect(riskOf('echo `git status`')).toBe('unknown');
    expect(riskOf('echo $HOME')).toBe('unknown');
    expect(riskOf('echo "${HOME}"')).toBe('unknown');
    expect(riskOf("echo $'a\\nb'")).toBe('unknown');
    expect(kinds('echo $(pwd)')).toContain('shell.substitution');
  });

  it('重定向 / 子 shell / 分组 / 后台执行判 unknown', () => {
    expect(riskOf('cat file > copy.txt')).toBe('unknown');
    expect(riskOf('ls >> log.txt')).toBe('unknown');
    expect(riskOf('definitely-not-a-command 2>/dev/null')).toBe('unknown');
    expect(riskOf('(cd /tmp && ls)')).toBe('unknown');
    expect(riskOf('ls &')).toBe('unknown');
    expect(kinds('cat a > b')).toContain('shell.redirect');
  });

  it('解释器包装里的危险命令仍判 dangerous', () => {
    expect(riskOf("bash -c 'rm -rf dist'")).toBe('dangerous');
    expect(riskOf("bash -lc 'git push origin main'")).toBe('dangerous');
    expect(riskOf("sh -c 'git reset --hard'")).toBe('dangerous');
  });

  it('未命中危险规则的解释器包装仍为 unknown', () => {
    expect(riskOf("bash -c 'echo safe'")).toBe('unknown');
    expect(riskOf(`bash -c "echo 'a&b|c'"`)).toBe('unknown');
    expect(riskOf('node -e "console.log(1)"')).toBe('unknown');
    expect(riskOf("python -c 'print(1)'")).toBe('unknown');
    expect(riskOf('eval "rm -rf /"')).toBe('unknown');
    expect(riskOf('FOO=bar pwd')).toBe('unknown');
    expect(riskOf('/usr/local/bin/custom-tool')).toBe('unknown');
  });

  it('解释器包装的递归分析有界', () => {
    let command = 'echo safe';
    for (let depth = 0; depth < 10; depth += 1) {
      command = `bash -c ${JSON.stringify(command)}`;
    }

    expect(riskOf(command)).toBe('unknown');
  });

  it('未列入白名单的命令判 unknown', () => {
    expect(riskOf('tar -xf a.tar')).toBe('dangerous');
    expect(riskOf('whatever-custom-tool --flag')).toBe('unknown');
  });

  it('空命令与纯连接符判 unknown', () => {
    expect(riskOf('   ')).toBe('unknown');
    expect(riskOf('&&')).toBe('unknown');
  });

  it('单引号里的 $ 是字面量，不触发变量告警', () => {
    expect(riskOf(`grep '$HOME' file.txt`)).toBe('safe');
  });

  it('summarizeRisk 返回第一个非 safe finding', () => {
    expect(summarizeRisk(analyzeShellCommand('pnpm test'))).toMatchObject({ kind: 'pkg.test' });
    expect(summarizeRisk(analyzeShellCommand('unknown-tool --x'))).toMatchObject({ kind: 'unknown' });
  });
});
