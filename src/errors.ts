/** 预期内的工具失败：由 registry 转成 `isError` 文本结果，不把栈泄漏给模型。 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
