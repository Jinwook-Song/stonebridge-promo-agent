import type { DemoSeed } from "../app/demo/seed-sql";
import { BASE_SEED } from "./base-seed";
import { SAMPLES } from "./samples";

/** What the public demo holds after every reset (fictional shop, see base-seed.ts). */
export const DEMO_SEED: DemoSeed = { ...BASE_SEED, ...SAMPLES };
