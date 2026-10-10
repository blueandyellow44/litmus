import { pool } from "../client.js";
import type { Source, NewSource, Register } from "../../types.js";
import { outletKeyFromName, resolveOutletKey } from "../../ingestion/outletKey.js";
import { logger } from "../../lib/logger.js";

interface SourceRow {
  id: number;
  name: string;
  // Nullable in the database: 0001_story_ledger adds it without NOT NULL so the
  // previous seeder keeps working through the rollback window. A row written by
  // that seeder reads back with the key its name derives.
  outlet_key: string | null;
  rss_url: string;
  lean: Source["lean"];
  type: Source["type"];
  paywall_status: Source["paywallStatus"];
  reliability: number;
  prominence: number | null;
  enabled: boolean;
  register: Register | null;
}

// Sources whose stored key was unusable and got a fallback. Kept so a bad row
// names itself once per process instead of on every read of the roster.
const warnedFallbackSourceIds = new Set<number>();

// The read path never throws over one bad row. resolveOutletKey is strict on
// purpose, but it is strict for WRITES: refusing a row the CHECK constraint
// would reject is right when the row is about to be stored, and wrong when it
// is already stored, because it turns one malformed source into a failed
// listAllSources and an empty roster. The window where outlet_key can be NULL
// is exactly the two-phase rollback window this column was made nullable for,
// so a read must degrade there, not die.
function readOutletKey(r: SourceRow): string {
  if (r.outlet_key !== null) return r.outlet_key;
  const derived = outletKeyFromName(r.name);
  if (derived !== null) return derived;
  // Last resort: unique, well formed, and obviously synthetic, so the matrix
  // still counts this outlet as one outlet and the key is traceable to its row.
  const fallback = `source-${r.id}`;
  if (!warnedFallbackSourceIds.has(r.id)) {
    warnedFallbackSourceIds.add(r.id);
    logger.warn("source has no outlet_key and none can be derived from its name", {
      sourceId: r.id,
      name: r.name,
      fallback,
    });
  }
  return fallback;
}

function rowToSource(r: SourceRow): Source {
  return {
    id: r.id,
    name: r.name,
    outletKey: readOutletKey(r),
    rssUrl: r.rss_url,
    lean: r.lean,
    type: r.type,
    paywallStatus: r.paywall_status,
    reliability: r.reliability,
    prominence: r.prominence ?? 1.0,
    enabled: r.enabled,
    register: r.register ?? null,
  };
}

export async function listEnabledSources(): Promise<Source[]> {
  const { rows } = await pool.query<SourceRow>(
    "SELECT * FROM sources WHERE enabled = TRUE ORDER BY id",
  );
  return rows.map(rowToSource);
}

export async function listAllSources(): Promise<Source[]> {
  const { rows } = await pool.query<SourceRow>("SELECT * FROM sources ORDER BY id");
  return rows.map(rowToSource);
}

// Upsert by rss_url. Returns the resulting source. Used by the seeder.
export async function upsertSource(s: NewSource): Promise<Source> {
  const { rows } = await pool.query<SourceRow>(
    `INSERT INTO sources (name, rss_url, lean, type, paywall_status, reliability, enabled, prominence, register, outlet_key)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, TRUE), COALESCE($8, 1.0), $9, $10)
     ON CONFLICT (rss_url) DO UPDATE SET
       name = EXCLUDED.name,
       lean = EXCLUDED.lean,
       type = EXCLUDED.type,
       paywall_status = EXCLUDED.paywall_status,
       reliability = EXCLUDED.reliability,
       prominence = EXCLUDED.prominence,
       register = EXCLUDED.register,
       outlet_key = EXCLUDED.outlet_key
     RETURNING *`,
    [s.name, s.rssUrl, s.lean, s.type, s.paywallStatus, s.reliability, s.enabled ?? null, s.prominence ?? null, s.register ?? null, resolveOutletKey(s)],
  );
  return rowToSource(rows[0]!);
}
