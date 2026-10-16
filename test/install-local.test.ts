import { constants } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installScript = join(projectRoot, 'install.sh');

const targets = [
  { os: 'Darwin', arch: 'x86_64', build: 'build:macos:x64', artifact: 'mcpx-lite-macos-x64' },
  { os: 'Darwin', arch: 'arm64', build: 'build:macos:arm64', artifact: 'mcpx-lite-macos-arm64' },
  { os: 'Linux', arch: 'x86_64', build: 'build:linux:x64', artifact: 'mcpx-lite-linux-x64' },
  { os: 'Linux', arch: 'aarch64', build: 'build:linux:arm64', artifact: 'mcpx-lite-linux-arm64' },
] as const;

describe.skipIf(process.platform === 'win32')('本地二进制安装脚本', () => {
  it('按当前 OS/架构构建，并将可执行文件安装到用户 bin 目录', async () => {
    for (const target of targets) {
      const fixture = await createFixture(target.os, target.arch);
      try {
        const result = fixture.run();
        expect(result.status, result.stderr).toBe(0);
        expect(await readFile(fixture.pnpmLog, 'utf8')).toBe(`run ${target.build}\n`);

        const installed = join(fixture.home, '.local', 'bin', 'mcpx-lite');
        expect(await readFile(installed, 'utf8')).toBe(`built ${target.build}\n`);
        await expect(access(installed, constants.X_OK)).resolves.toBeUndefined();
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it('不支持的平台在构建前失败，且不覆盖已有安装', async () => {
    const fixture = await createFixture('FreeBSD', 'x86_64');
    try {
      const binDir = join(fixture.home, '.local', 'bin');
      await mkdir(binDir, { recursive: true });
      await writeFile(join(binDir, 'mcpx-lite'), 'existing binary\n', 'utf8');

      const result = fixture.run();

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Unsupported platform');
      await expect(readFile(fixture.pnpmLog, 'utf8')).rejects.toThrow();
      expect(await readFile(join(binDir, 'mcpx-lite'), 'utf8')).toBe('existing binary\n');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

async function createFixture(os: string, arch: string) {
  const root = await mkdtemp(join(tmpdir(), 'mcpx-lite-install-'));
  const fakeBin = join(root, 'bin');
  const home = join(root, 'home');
  const pnpmLog = join(root, 'pnpm.log');
  await mkdir(fakeBin, { recursive: true });
  await mkdir(home, { recursive: true });
  await symlink(installScript, join(root, 'install.sh'));
  await writeFile(
    join(fakeBin, 'uname'),
    '#!/bin/sh\ncase "$1" in\n  -s) printf "%s\\n" "$INSTALL_TEST_OS" ;;\n  -m) printf "%s\\n" "$INSTALL_TEST_ARCH" ;;\n  *) exit 2 ;;\nesac\n',
  );
  await writeFile(join(fakeBin, 'bun'), '#!/bin/sh\nexit 0\n');
  await writeFile(
    join(fakeBin, 'pnpm'),
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" > "$INSTALL_TEST_PNPM_LOG"',
      'case "$2" in',
      '  build:macos:x64) artifact=mcpx-lite-macos-x64 ;;',
      '  build:macos:arm64) artifact=mcpx-lite-macos-arm64 ;;',
      '  build:linux:x64) artifact=mcpx-lite-linux-x64 ;;',
      '  build:linux:arm64) artifact=mcpx-lite-linux-arm64 ;;',
      '  *) exit 3 ;;',
      'esac',
      'mkdir -p "$INSTALL_TEST_ROOT/dist"',
      'printf "built %s\\n" "$2" > "$INSTALL_TEST_ROOT/dist/$artifact"',
    ].join('\n') + '\n',
  );
  await Promise.all([join(fakeBin, 'uname'), join(fakeBin, 'bun'), join(fakeBin, 'pnpm')].map((path) => chmod(path, 0o755)));

  return {
    root,
    home,
    pnpmLog,
    run: () =>
      spawnSync('/bin/bash', [join(root, 'install.sh')], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          INSTALL_TEST_OS: os,
          INSTALL_TEST_ARCH: arch,
          INSTALL_TEST_PNPM_LOG: pnpmLog,
          INSTALL_TEST_ROOT: root,
        },
      }),
  };
}
