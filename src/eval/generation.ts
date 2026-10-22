import { stat } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { MAX_PROFILE_DELAY_MS, PROFILE_API_MODES } from '../../evals/app/server.ts';
import { GENERATION_FILE, loadScenarioFile, RegexSource, scenarioDir, ScenarioId, SCENARIOS_DIR } from './scenarios.ts';

// Generator-side scenario data: how to produce a failure, nothing about how to diagnose it.
// This module must never import truth.ts; separation.test.ts enforces that.

const SPEC_PATH = /^tests\/ui\/[a-z0-9-]+\.spec\.ts$/;
const ATTACHMENTS = ['trace', 'screenshot', 'error-context'] as const;
/** Where an edited spec lives in the scenario directory: `post-run/` + the spec path. */
export const POST_RUN_DIR = 'post-run';

// Every field added after the Stage 2.5 pilot is optional, and leaving it out reproduces the pilot
// behavior exactly, so the pilot generation files (and their hashes) never change.

export const GenerationConfig = z
  .strictObject({
    id: ScenarioId,
    spec: z
      .string()
      .regex(SPEC_PATH, 'spec must be tests/ui/<name>.spec.ts')
      .describe('Path of the test file, relative to the scenario directory and to the generated workspace'),
    app: z
      .strictObject({
        profileApi: z.enum(PROFILE_API_MODES),
        profileDelayMs: z.number().int().min(1).max(MAX_PROFILE_DELAY_MS).optional().describe('Delay before a successful /api/profile response'),
        server: z.enum(['up', 'down']).optional().describe('down: BASE_URL points at a released local port, so connections are refused. Default up'),
      })
      .describe('Fixture app settings, passed by the generator, never written to the workspace'),
    playwright: z.strictObject({
      retries: z.number().int().min(0).max(2),
      testTimeoutMs: z.number().int().min(1_000).max(60_000),
      trace: z.enum(['retain-on-failure', 'off']).optional().describe('Default retain-on-failure'),
      screenshot: z.enum(['only-on-failure', 'off']).optional().describe('Default only-on-failure'),
    }),
    postRun: z
      .strictObject({
        replaceSpec: z.literal(true).describe(`After Playwright exits, the stage spec is overwritten with ${POST_RUN_DIR}/<spec>, so it is newer than the run and differs from the artifacts`),
      })
      .optional(),
    expectObservation: z
      .strictObject({
        outcome: z.enum(['expected', 'unexpected', 'flaky']),
        errorPattern: RegexSource.nullable()
          .describe('Matched against the failed attempts\' error messages; null when nothing should fail'),
        attachments: z.array(z.enum(ATTACHMENTS)).describe('Attachments the failed attempt must have'),
        absentAttachments: z.array(z.enum(ATTACHMENTS)).optional().describe('Attachments no attempt may list, and whose files must not exist'),
        errorContextPattern: RegexSource.optional().describe("Matched against each failed attempt's error-context.md (what the page showed)"),
        maxFailedAttemptMs: z.number().int().positive().optional().describe("Upper bound on each failed attempt's duration, e.g. to show it failed at once instead of timing out"),
        sourceTiming: z
          .enum(['before-run', 'after-run'])
          .optional()
          .describe('before-run (default): the spec is older than the run. after-run: newer than the run end, and the failing line differs from the snippet'),
      })
      .describe('What the generated run must show before its snapshot is accepted. Provisional until checked against real artifacts.'),
  })
  .superRefine((config, ctx) => {
    const expect = config.expectObservation;
    const afterRun = expect.sourceTiming === 'after-run';
    if (afterRun !== (config.postRun !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['postRun'], message: 'postRun and expectObservation.sourceTiming "after-run" go together' });
    }
    if (afterRun && expect.outcome !== 'unexpected') {
      ctx.addIssue({ code: 'custom', path: ['expectObservation', 'sourceTiming'], message: 'a source mismatch needs a failed attempt to compare against' });
    }
    const both = (expect.absentAttachments ?? []).filter((a) => expect.attachments.includes(a));
    if (both.length > 0) ctx.addIssue({ code: 'custom', path: ['expectObservation', 'absentAttachments'], message: `both required and absent: ${both.join(', ')}` });
    const off = [config.playwright.trace === 'off' ? 'trace' : null, config.playwright.screenshot === 'off' ? 'screenshot' : null];
    for (const name of off) {
      if (name && expect.attachments.some((a) => a === name)) {
        ctx.addIssue({ code: 'custom', path: ['expectObservation', 'attachments'], message: `${name} is turned off but required` });
      }
    }
  });
export type GenerationConfig = z.infer<typeof GenerationConfig>;

/** The edited spec a postRun scenario copies over the stage spec, relative to the scenario directory. */
export function postRunSpecPath(config: GenerationConfig): string | null {
  return config.postRun ? `${POST_RUN_DIR}/${config.spec}` : null;
}

/** Reads only the scenario's generation file and checks its spec (and edited spec) exist. */
export async function loadGenerationConfig(id: string, root: string = SCENARIOS_DIR): Promise<GenerationConfig> {
  const config = await loadScenarioFile(GenerationConfig, id, GENERATION_FILE, root);
  for (const rel of [config.spec, postRunSpecPath(config)]) {
    if (rel === null) continue;
    const info = await stat(path.join(scenarioDir(id, root), ...rel.split('/'))).catch(() => null);
    if (!info?.isFile()) throw new Error(`Scenario ${id}: spec ${rel} does not exist.`);
  }
  return config;
}
