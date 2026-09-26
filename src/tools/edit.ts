import * as z from 'zod/v4';
import { APPROVAL_INPUT_FIELDS, enforceApproval, hashArgs, type ApprovalCodec } from '../approval.js';
import { commitPreparedEdits, prepareBatchEdits } from '../edit-batch.js';
import { ToolError } from '../errors.js';
import { defineTool, withGoalReason, type ToolDef } from '../registry.js';
import { isInsideBase, resolvePath } from '../session.js';

const replacementSchema = z.object({
  oldText: z.string().min(1).describe('要被替换的原文；每一步必须恰好匹配一次'),
  newText: z.string().describe('替换后的内容；空串表示删除'),
});

const fileEditSchema = z.object({
  path: z.string().min(1).describe('相对路径基于 session.base 解析；绝对路径直接使用；允许 ..'),
  replacements: z.array(replacementSchema).min(1).describe('按数组顺序应用的精确字面量替换'),
});

export const editSchema = withGoalReason({
  sessionId: z.string().min(1).describe('session create 返回的会话 id'),
  edits: z.array(fileEditSchema).min(1).max(100).describe('要作为一个批次执行的文件编辑'),
  ...APPROVAL_INPUT_FIELDS,
});

export const EDIT_DESCRIPTION = `批量精确替换一个或多个文件中的文本（字面量匹配，不是正则）。

用途：改代码的主力工具。每个 replacement 的 oldText 在当时内容中必须恰好出现一次。
整个 edits[] 是一个批次：全部预检成功前不写入；提交中途失败时尽力回滚已写文件。
旧 path / oldText / newText schema 已被废弃，调用只接受 edits[]。
参数：
- sessionId：必填
- edits：文件编辑数组；每个文件含 path 与按顺序应用的 replacements
- goal / reason：可选审计字段；提供时写入 session history

示例：
{ "sessionId": "ses_ab12cd34ef56", "edits": [{ "path": "src/config.ts", "replacements": [{ "oldText": "timeout: 30,", "newText": "timeout: 60," }] }] }`;

export function createEditTool(approvals: ApprovalCodec): ToolDef {
  return defineTool({
    name: 'edit',
    title: 'Edit（批量精确替换）',
    description: EDIT_DESCRIPTION,
    schema: editSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    requiresSession: true,
    describeCall: (args, session) => ({
      target: `${args.edits.length} files`,
      files: session ? args.edits.map((edit) => resolvePath(session.base, edit.path)) : [],
      fields: { paths: args.edits.map((edit) => edit.path) },
    }),
    handler: async (args, _ctx, session, observe) => {
      if (!session) throw new ToolError('edit 需要有效 sessionId');

      const prepared = await prepareBatchEdits(session.base, args.edits);

      const outsideTargets = prepared.filter((file) => !isInsideBase(session.base, file.target));
      if (outsideTargets.length > 0) {
        const contextHash = hashArgs(prepared.map((file) => [file.target, file.originalHash]));
        const approval = await enforceApproval({
          codec: approvals,
          sessionId: session.id,
          tool: 'edit',
          argsHash: hashArgs(args.edits),
          contextHash,
          contextMismatchMessage: `concurrent_modification: target changed while awaiting approval`,
          ...(args.approvalToken ? { approvalToken: args.approvalToken } : {}),
          ...(args.approvalDecision ? { approvalDecision: args.approvalDecision } : {}),
          observer: observe,
          prompt: {
            risk: 'dangerous',
            riskLabel: 'edit.outside-base · 批次包含 session.base 外真实目标',
            summary: `批量编辑 ${prepared.length} 个文件`,
            message: [
              '这个批量编辑包含 session.base 之外的真实目标：',
              '',
              ...outsideTargets.map((file) => `- ${file.target}`),
              '',
              `base：${session.base}`,
            ].join('\n'),
            fields: { paths: outsideTargets.map((file) => file.target) },
          },
        });
        if (approval) return approval;
      }

      await commitPreparedEdits(prepared);
      return {
        files: prepared.length,
        replacements: prepared.reduce((total, file) => total + file.replacements, 0),
      };
    },
  });
}
