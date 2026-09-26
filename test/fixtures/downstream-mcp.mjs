import { writeFileSync } from 'node:fs';
import { McpServer, inputRequired } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

if (process.env.FIXTURE_START_MARKER) {
  writeFileSync(process.env.FIXTURE_START_MARKER, 'started', 'utf8');
}

serveStdio(() => {
  const server = new McpServer(
    { name: 'downstream-fixture', version: '1.0.0' },
    { instructions: 'fixture instructions' },
  );

  server.registerTool(
    'echo',
    {
      description: 'Echo text',
      inputSchema: z.object({ text: z.string() }),
      outputSchema: z.object({ echoed: z.string() }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ text }) => ({
      content: [{ type: 'text', text }],
      structuredContent: { echoed: text },
    }),
  );

  server.registerTool(
    'mutate',
    {
      description: 'Write mutation marker',
      inputSchema: z.object({ value: z.string() }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ value }) => {
      if (process.env.FIXTURE_MUTATION_MARKER) {
        writeFileSync(process.env.FIXTURE_MUTATION_MARKER, value, 'utf8');
      }
      return { content: [{ type: 'text', text: 'mutated:' + value }] };
    },
  );

  server.registerTool(
    'unannotated',
    {
      description: 'Tool without annotations',
      inputSchema: z.object({ value: z.string() }),
    },
    async ({ value }) => ({
      content: [{ type: 'text', text: 'unannotated:' + value }],
    }),
  );

  server.registerTool(
    'needs_input',
    {
      description: 'Request one elicited value then echo retry material',
      inputSchema: z.object({}),
      outputSchema: z.object({
        state: z.string(),
        responses: z.record(z.string(), z.unknown()),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (_args, ctx) => {
      const state = ctx.mcpReq.requestState();
      if (state === undefined) {
        return inputRequired({
          requestState: 'opaque:α/二\nline',
          inputRequests: {
            answer: inputRequired.elicit({
              message: 'Provide fixture value',
              requestedSchema: z.object({ value: z.string() }),
            }),
          },
        });
      }

      return {
        content: [{ type: 'text', text: 'mrtr-complete' }],
        structuredContent: {
          state,
          responses: ctx.mcpReq.inputResponses ?? {},
        },
      };
    },
  );

  server.registerResource(
    'hello',
    'fixture://hello',
    { title: 'Fixture Resource', mimeType: 'text/plain' },
    async (uri) => ({
      contents: [{ uri: uri.href, text: 'fixture resource' }],
    }),
  );

  server.registerResource(
    'needs-input-resource',
    'fixture://needs-input',
    { title: 'Interactive Fixture Resource', mimeType: 'application/json' },
    async (uri, ctx) => {
      const state = ctx.mcpReq.requestState();
      if (state === undefined) {
        return inputRequired({
          requestState: 'resource-state:α/二\nline',
          inputRequests: {
            answer: inputRequired.elicit({
              message: 'Provide resource value',
              requestedSchema: z.object({ value: z.string() }),
            }),
          },
        });
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({
              state,
              responses: ctx.mcpReq.inputResponses ?? {},
            }),
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'review',
    {
      description: 'Review fixture code',
      argsSchema: z.object({ code: z.string() }),
    },
    ({ code }) => ({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: `Review: ${code}` },
        },
      ],
    }),
  );

  server.registerPrompt(
    'needs_input_prompt',
    {
      description: 'Prompt that requests one value before completing',
      argsSchema: z.object({}),
    },
    (_args, ctx) => {
      const state = ctx.mcpReq.requestState();
      if (state === undefined) {
        return inputRequired({
          requestState: 'prompt-state:α/二\nline',
          inputRequests: {
            answer: inputRequired.elicit({
              message: 'Provide prompt value',
              requestedSchema: z.object({ value: z.string() }),
            }),
          },
        });
      }

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: JSON.stringify({
                state,
                responses: ctx.mcpReq.inputResponses ?? {},
              }),
            },
          },
        ],
      };
    },
  );

  return server;
});
