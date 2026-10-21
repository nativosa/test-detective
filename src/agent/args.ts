import { parseArgs } from 'node:util';
import * as z from 'zod';

// CLI argument parsing. Pure: takes argv, returns validated settings or a usage error.

export const USAGE = `Usage: npm run investigate [-- options]

Investigates existing Playwright failures (artifacts/results.json) with the Claude Agent SDK.
Read-only: never edits files or runs tests.

Options:
  --test <filter>         Only failures whose title or spec file contains <filter>
  --model <id>            Model ID or alias (default: your account's default)
  --max-turns <n>         Maximum agent turns, 1-100 (default 30)
  --timeout <seconds>     Wall-clock limit, 10-3600 (default 300)
  --max-budget-usd <n>    Stop when the SDK's estimated cost exceeds n (optional)
  --auth <mode>           subscription (default) or api. See README "Authentication".
  --json                  Print the full result as JSON instead of Markdown
  --help                  Show this help`;

const CliArgs = z.strictObject({
  filter: z
    .string()
    .trim()
    .min(1, '--test must not be empty')
    .max(200, '--test is limited to 200 characters')
    .regex(/^[^\p{Cc}]*$/u, '--test must not contain control characters')
    .nullable(),
  model: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9.\-_[\]]{0,99}$/, '--model must be a model ID or alias such as claude-opus-5-5')
    .nullable(),
  maxTurns: z.coerce
    .number('--max-turns must be a number')
    .int('--max-turns must be an integer')
    .min(1, '--max-turns must be 1-100')
    .max(100, '--max-turns must be 1-100'),
  timeoutMs: z.coerce
    .number('--timeout must be a number of seconds')
    .min(10, '--timeout must be 10-3600 seconds')
    .max(3600, '--timeout must be 10-3600 seconds')
    .transform((s) => Math.round(s * 1000)),
  maxBudgetUsd: z.coerce
    .number('--max-budget-usd must be a number')
    .positive('--max-budget-usd must be positive')
    .max(100, '--max-budget-usd is limited to 100')
    .nullable(),
  auth: z.enum(['subscription', 'api'], { error: '--auth must be "subscription" or "api"' }),
  json: z.boolean(),
});
export type CliArgs = z.infer<typeof CliArgs>;

export type ParsedArgs = { kind: 'run'; args: CliArgs } | { kind: 'help' } | { kind: 'error'; message: string };

export function parseCliArgs(argv: string[]): ParsedArgs {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        test: { type: 'string' },
        model: { type: 'string' },
        'max-turns': { type: 'string' },
        timeout: { type: 'string' },
        'max-budget-usd': { type: 'string' },
        auth: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  if (values.help) return { kind: 'help' };

  const parsed = CliArgs.safeParse({
    filter: values.test ?? null,
    model: values.model ?? null,
    maxTurns: values['max-turns'] ?? 30,
    timeoutMs: values.timeout ?? 300,
    maxBudgetUsd: values['max-budget-usd'] ?? null,
    auth: values.auth ?? 'subscription',
    json: values.json ?? false,
  });
  if (!parsed.success) return { kind: 'error', message: parsed.error.issues.map((i) => i.message).join('; ') };
  return { kind: 'run', args: parsed.data };
}
