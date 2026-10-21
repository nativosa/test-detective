import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod';

// Scenario discovery shared by the generation and ground-truth loaders. It knows directory and
// file names only, never what the files contain, so it can't couple generation to ground truth.

export const SCENARIOS_DIR = fileURLToPath(new URL('../../evals/scenarios/', import.meta.url));

/** How to produce the failure. Read by the generator. */
export const GENERATION_FILE = 'generation.json';
/** What a correct investigation concludes. Read only by scoring and dataset tests. */
export const TRUTH_FILE = 'truth.json';

export const ScenarioId = z.string().regex(/^S\d{2}$/, 'scenario IDs look like S01');

/** A JavaScript regular expression source. Consumers compile it case-insensitively. */
export const RegexSource = z.string().min(1).refine((source) => {
  try {
    new RegExp(source, 'i');
    return true;
  } catch {
    return false;
  }
}, 'must be a valid regular expression');

/** Scenario IDs under `root`, sorted. Only directories named like an ID count. */
export async function listScenarioIds(root: string = SCENARIOS_DIR): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && ScenarioId.safeParse(e.name).success)
    .map((e) => e.name)
    .sort();
}

export function scenarioDir(id: string, root: string = SCENARIOS_DIR): string {
  return path.join(root, ScenarioId.parse(id));
}

export async function readJson(file: string): Promise<unknown> {
  const text = await readFile(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Parses with `schema` and checks the file's `id` matches its directory. */
export async function loadScenarioFile<T extends { id: string }>(schema: z.ZodType<T>, id: string, file: string, root: string): Promise<T> {
  const full = path.join(scenarioDir(id, root), file);
  const parsed = schema.safeParse(await readJson(full));
  if (!parsed.success) throw new Error(`${full} is invalid:\n${z.prettifyError(parsed.error)}`);
  if (parsed.data.id !== id) throw new Error(`${full} has id ${parsed.data.id}, but its directory is ${id}.`);
  return parsed.data;
}
