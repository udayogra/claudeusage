import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRICING_PATH = join(__dirname, "..", "pricing.json");

export interface Rate {
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
}

interface PricingFile {
  default: Rate;
  models: (Rate & { match: string })[];
}

let cache: PricingFile | null = null;
let cacheMtime = 0;

function load(): PricingFile {
  if (!existsSync(PRICING_PATH)) {
    return {
      default: { input: 3, output: 15, cache_read: 0.3, cache_write_5m: 3.75, cache_write_1h: 6 },
      models: [],
    };
  }
  const raw = readFileSync(PRICING_PATH, "utf8");
  const parsed = JSON.parse(raw) as PricingFile;
  // sort by longest match first so more specific rules win
  parsed.models = (parsed.models ?? []).sort((a, b) => b.match.length - a.match.length);
  return parsed;
}

export function getPricing(): PricingFile {
  cache = load();
  return cache;
}

export function rateFor(model: string): Rate {
  const p = getPricing();
  const hit = p.models.find((m) => model.startsWith(m.match) || model.includes(m.match));
  return hit ?? p.default;
}

export interface TokenBreakdown {
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
}

/** Cost in USD for a token breakdown under a given model's rate. */
export function costOf(model: string, t: TokenBreakdown): number {
  const r = rateFor(model);
  return (
    (t.input_tokens * r.input +
      t.output_tokens * r.output +
      t.cache_read * r.cache_read +
      t.cache_write_5m * r.cache_write_5m +
      t.cache_write_1h * r.cache_write_1h) /
    1_000_000
  );
}

/** What input+cache would have cost at full input price (no caching) — used to show savings. */
export function uncachedInputCostOf(model: string, t: TokenBreakdown): number {
  const r = rateFor(model);
  const inputEquivalent = t.input_tokens + t.cache_read + t.cache_write_5m + t.cache_write_1h;
  return (inputEquivalent * r.input) / 1_000_000;
}
