import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { ToolError } from './errors.js';
import { writeFileAtomic } from './paths.js';
import { resolvePath } from './session.js';

export interface BatchReplacement {
  oldText: string;
  newText: string;
}

export interface BatchFileEdit {
  path: string;
  replacements: BatchReplacement[];
}

export interface PreparedBatchEdit {
  absolute: string;
  target: string;
  original: string;
  originalHash: string;
  content: string;
  replacements: number;
}

export async function prepareBatchEdits(base: string, edits: BatchFileEdit[]): Promise<PreparedBatchEdit[]> {
  const prepared: PreparedBatchEdit[] = [];
  const seenTargets = new Set<string>();

  for (const [editIndex, edit] of edits.entries()) {
    const absolute = resolvePath(base, edit.path);
    let info;
    try {
      info = await stat(absolute);
    } catch {
      throw new ToolError(`file does not exist: ${absolute} (editIndex=${editIndex}, path=${edit.path})`);
    }
    if (!info.isFile()) {
      throw new ToolError(`not a regular file: ${absolute} (editIndex=${editIndex}, path=${edit.path})`);
    }

    const target = await realpath(absolute);
    if (seenTargets.has(target)) {
      throw new ToolError(`duplicate target: ${target} (editIndex=${editIndex}, path=${edit.path})`);
    }
    seenTargets.add(target);

    const original = await readFile(target, 'utf8');
    let current = original;
    for (const [replacementIndex, replacement] of edit.replacements.entries()) {
      const occurrences = current.split(replacement.oldText).length - 1;
      if (occurrences === 0) {
        throw new ToolError(
          `oldText not found in ${absolute} (editIndex=${editIndex}, replacementIndex=${replacementIndex}, path=${edit.path})`,
        );
      }
      if (occurrences > 1) {
        throw new ToolError(
          `oldText matches ${occurrences} times in ${absolute} (editIndex=${editIndex}, replacementIndex=${replacementIndex}, path=${edit.path})`,
        );
      }
      current = current.replace(replacement.oldText, replacement.newText);
    }

    prepared.push({
      absolute,
      target,
      original,
      originalHash: contentHash(original),
      content: current,
      replacements: edit.replacements.length,
    });
  }

  return prepared;
}

export interface BatchEditCommitIO {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
}

const DEFAULT_COMMIT_IO: BatchEditCommitIO = {
  read: (path) => readFile(path, 'utf8'),
  write: writeFileAtomic,
};

export async function commitPreparedEdits(
  prepared: PreparedBatchEdit[],
  io: BatchEditCommitIO = DEFAULT_COMMIT_IO,
): Promise<void> {
  for (const file of prepared) {
    const current = await io.read(file.target);
    if (contentHash(current) !== file.originalHash) {
      throw new ToolError(`concurrent modification: ${file.target}`);
    }
  }

  const committed: PreparedBatchEdit[] = [];
  try {
    for (const file of prepared) {
      await io.write(file.target, file.content);
      committed.push(file);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const uncertainPaths: string[] = [];
    for (const file of committed.reverse()) {
      try {
        await io.write(file.target, file.original);
      } catch {
        uncertainPaths.push(file.target);
      }
    }

    if (uncertainPaths.length > 0) {
      throw new ToolError(
        `batch edit commit failed: ${message}; rollbackSucceeded=false; uncertainPaths=${JSON.stringify(uncertainPaths)}`,
      );
    }
    throw new ToolError(`batch edit commit failed: ${message}; rollbackSucceeded=true`);
  }
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
