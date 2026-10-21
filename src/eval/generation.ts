import { stat } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { PROFILE_API_MODES } from '../../evals/app/server.ts';
import { GENERATION_FILE, loadScenarioFile, RegexSource, scenarioDir, ScenarioId, SCENARIOS_DIR } from './scenarios.ts';

// Generator-side scenario data: how to produce a failure, nothing about how to diagnose it.
// This module must never import truth.ts; separation.test.ts enforces that.

const SPEC_PATH = /^tests\/ui\/[a-z0-9-]+\.spec\.ts$/;
const ATTACHMENTS = ['trace', 'screenshot', 'error-context'] as const;

export const GenerationConfig = z.strictObject({
  id: ScenarioId,
  spec: z
    .string()
    .regex(SPEC_PATH, 'spec must be tests/ui/<name>.spec.ts')
    .describe('Path of the test file, relative to the scenario directory and to the generated workspace'),
  app: z.strictObject({ profileApi: z.enum(PROFILE_API_MODES) }).describe('Fixture app settings, passed by the generator, never written to the workspace'),
  playwright: z.strictObject({
    retries: z.number().int().min(0).max(2),
    testTimeoutMs: z.number().int().min(1_000).max(60_000),
  }),
  expectObservation: z
    .strictObject({
      outcome: z.enum(['expected', 'unexpected', 'flaky']),
      errorPattern: RegexSource.nullable()
        .describe('Matched against the failed attempts\' error messages; null when nothing should fail'),
      attachments: z.array(z.enum(ATTACHMENTS)).describe('Attachments the failed attempt must have'),
    })
    .describe('What the generated run must show before its snapshot is accepted. Provisional until checked against real artifacts.'),
});
export type GenerationConfig = z.infer<typeof GenerationConfig>;

/** Reads only the scenario's generation file and checks its spec exists. */
export async function loadGenerationConfig(id: string, root: string = SCENARIOS_DIR): Promise<GenerationConfig> {
  const config = await loadScenarioFile(GenerationConfig, id, GENERATION_FILE, root);
  const spec = path.join(scenarioDir(id, root), ...config.spec.split('/'));
  const info = await stat(spec).catch(() => null);
  if (!info?.isFile()) throw new Error(`Scenario ${id}: spec ${config.spec} does not exist.`);
  return config;
}
