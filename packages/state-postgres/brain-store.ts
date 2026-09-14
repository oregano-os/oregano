import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import type { BrainStore, BrainSearchHit } from "../state-store/brain.ts";
import { BrainError, type BrainLink, type BrainPage, type BrainRevision, type BrainScope } from "../brain/contracts.ts";
import { normalizeBrainReference } from "../brain/paths.ts";
import { postgresTimestampToIso } from "./postgres-values.ts";

const connection = () => {
  if (!process.env.DATABASE_URL) throw new BrainError("database_unavailable", "Brain uses the bound Company Instance database.");
  return neon(process.env.DATABASE_URL);
};
const readRevision = (row: Record<string, any>): BrainRevision => ({ git_commit: row.git_commit, configuration_digest: row.configuration_digest,
  generation: row.generation, sequence: Number(row.sequence), indexed_at: postgresTimestampToIso(row.indexed_at) });
const language = (column: string) => `(case split_part(lower(${column}), '-', 1) when 'en' then 'pg_catalog.english' when 'de' then 'pg_catalog.german' when 'es' then 'pg_catalog.spanish' when 'fr' then 'pg_catalog.french' else 'pg_catalog.simple' end)::regconfig`;

export class PostgresBrainStore implements BrainStore {
  async revision(scope: BrainScope) {
    const rows = await connection().query("select * from companyos_brain.revisions where instance_id = $1 and repository_id = $2", [scope.instance_id, scope.repository_id]);
    return rows.length ? readRevision(rows[0]) : undefined;
  }
  /** A single MVCC statement checks the expected revision even if the data query returns no rows. */
  async guarded<T>(scope: BrainScope, expected: BrainRevision, query: string, values: unknown[]): Promise<T[]> {
    const rows = await connection().query(`with checkpoint as (
      select 1 from companyos_brain.revisions where instance_id = $1 and repository_id = $2
      and generation = $3::uuid and sequence = $4::bigint and git_commit = $5 and configuration_digest = $6
    ), selected as (${query}) select exists(select 1 from checkpoint) as matches,
      coalesce((select jsonb_agg(to_jsonb(selected)) from selected), '[]'::jsonb) as items`,
    [scope.instance_id, scope.repository_id, expected.generation, expected.sequence, expected.git_commit, expected.configuration_digest, ...values]);
    if (!rows[0]?.matches) throw new BrainError("snapshot_changed", "The indexed Brain revision changed during this read.");
    return rows[0].items as T[];
  }
  async find(scope: BrainScope, expected: BrainRevision, names: string[]) {
    const normalized = names.map(name => normalizeBrainReference(name).normalize("NFKC").toLocaleLowerCase("en"));
    const rows = await this.guarded<{ page_json: BrainPage }>(scope, expected, `select page_json from companyos_brain.pages p
      where instance_id = $1 and repository_id = $2 and (lower(slug) = any($7::text[]) or exists(
        select 1 from unnest($7::text[]) name where (lower(normalize(title, NFKC)) = name or name = any(aliases))
        and not exists(select 1 from companyos_brain.pages exact where exact.instance_id = $1 and exact.repository_id = $2 and lower(exact.slug) = name)))
      order by slug limit 257`, [normalized]);
    if (rows.length > 256) throw new BrainError("ambiguous_name_bound", "Too many matching page names; use a canonical slug.");
    return rows.map(row => row.page_json);
  }
  async pages(scope: BrainScope, expected: BrainRevision, slugs: string[]) {
    if (slugs.length > 100) throw new BrainError("read_bound", "Too many page references in one read.");
    return (await this.guarded<{ page_json: BrainPage }>(scope, expected, "select page_json from companyos_brain.pages where instance_id = $1 and repository_id = $2 and slug = any($7::text[]) order by slug", [slugs])).map(row => row.page_json);
  }
  async links(scope: BrainScope, expected: BrainRevision, slugs: string[], limit: number) {
    const rows = await this.guarded<BrainLink>(scope, expected, `select from_slug as "from", target, resolved_slug as resolved, relation, context
      from companyos_brain.links where instance_id = $1 and repository_id = $2 and (from_slug = any($7::text[]) or resolved_slug = any($7::text[]))
      order by from_slug, occurrence limit $8`, [slugs, limit + 1]);
    return { links: rows.slice(0, limit), has_more: rows.length > limit };
  }
  async search(scope: BrainScope, expected: BrainRevision, args: Parameters<BrainStore["search"]>[2]) {
    const config = language("p.language");
    // OR between lexemes supports self-contained natural-language questions without a model query-expansion call.
    const query = `to_tsquery(${config}, replace(plainto_tsquery(${config}, $7)::text, ' & ', ' | '))`;
    const filter = "p.instance_id = $1 and p.repository_id = $2 and ($8::text is null or p.page_type = $8) and ($9::text[] is null or p.slug = any($9::text[]))";
    const rows = await this.guarded<BrainSearchHit>(scope, expected, `select * from (
      select p.slug, p.title, p.page_type as type, left(p.current_text, 1200) as excerpt,
      ts_rank_cd(p.search_vector, ${query}) * p.search_weight as score, null::jsonb as take
      from companyos_brain.pages p where ${filter} and p.search_vector @@ ${query}
      union all
      select p.slug, p.title, p.page_type as type, t.take_json->>'claim' as excerpt,
      ts_rank_cd(t.search_vector, ${query}) * p.search_weight as score, t.take_json as take
      from companyos_brain.takes t join companyos_brain.pages p on p.instance_id = t.instance_id and p.repository_id = t.repository_id and p.slug = t.page_slug
      where ${filter} and t.active and t.search_vector @@ ${query}
    ) hits order by score desc, slug, coalesce((take->>'row_num')::int, 0) limit $10`, [args.query, args.type ?? null, args.slugs ?? null, args.limit + 1]);
    return { hits: rows.slice(0, args.limit).map(row => ({ ...row, ...(row.take ? { take: row.take } : { take: undefined }) })), has_more: rows.length > args.limit };
  }
  async inventory(scope: BrainScope, expected: BrainRevision) {
    return this.guarded<{ slug: string; content_hash: string }>(scope, expected, "select slug, content_hash from companyos_brain.pages where instance_id = $1 and repository_id = $2 order by slug", []);
  }
  async publish(args: Parameters<BrainStore["publish"]>[0]) {
    const sql = connection(), token = randomUUID();
    const { scope, expected, revision } = args;
    const pages = JSON.stringify(args.pages), changes = JSON.stringify(args.changes);
    const wireQueries: Array<{ query: string; params: unknown[] }> = [];
    const query = (text: string, values: unknown[]) => { wireQueries.push({ query: text, params: values }); return sql.query(text, values); };
    const params = [scope.instance_id, scope.repository_id, token, revision.git_commit, revision.configuration_digest, revision.generation,
      revision.sequence, revision.indexed_at, expected?.generation ?? null, expected?.sequence ?? null, expected?.git_commit ?? null,
      expected?.configuration_digest ?? null, args.lease.source_id, args.lease.token];
    const lease = "exists(select 1 from companyos_records.sync_leases where instance_id = $1 and source_id = $13 and lease_token = $14 and lease_expires_at > now())";
    const guard = `insert into companyos_brain.revisions (instance_id, repository_id, publication_token, git_commit, configuration_digest, generation, sequence, indexed_at)
      select $1, $2, $3::uuid, $4, $5, $6::uuid, $7::bigint, $8::timestamptz where ${lease}
      and ($9::uuid is null or exists(select 1 from companyos_brain.revisions where instance_id = $1 and repository_id = $2))
      on conflict (instance_id, repository_id) do update set publication_token = excluded.publication_token, git_commit = excluded.git_commit,
      configuration_digest = excluded.configuration_digest, generation = excluded.generation, sequence = excluded.sequence, indexed_at = excluded.indexed_at
      where companyos_brain.revisions.generation = $9::uuid and companyos_brain.revisions.sequence = $10::bigint
      and companyos_brain.revisions.git_commit = $11 and companyos_brain.revisions.configuration_digest = $12 and ${lease}
      returning publication_token`;
    const published = "exists(select 1 from companyos_brain.revisions where instance_id = $1 and repository_id = $2 and publication_token = $3::uuid)";
    const data = [scope.instance_id, scope.repository_id, token];
    const config = language("page->>'lang'");
    // Stage the snapshot once in this transaction. Repeating it for every
    // projection table would multiply the transport cost and hit HTTP bounds.
    const statements = [query("create temporary table brain_sync_payload (pages jsonb) on commit drop", []),
      query("insert into pg_temp.brain_sync_payload values ($1::jsonb)", [pages]), query(guard, params),
      query(`delete from companyos_brain.links where instance_id = $1 and repository_id = $2 and ${published}`, data.slice(0, 3)),
      query(`delete from companyos_brain.takes where instance_id = $1 and repository_id = $2 and ${published}`, data.slice(0, 3)),
      query(`delete from companyos_brain.pages where instance_id = $1 and repository_id = $2 and ${published}
        and slug not in (select page->>'slug' from jsonb_array_elements((select pages from pg_temp.brain_sync_payload)) page)`, data),
      query(`insert into companyos_brain.pages (instance_id, repository_id, slug, content_hash, title, page_type, aliases, language, search_weight, current_text, timeline, page_json, search_vector)
        select $1, $2, page->>'slug', page->>'content_hash', page->>'title', page->>'type',
        array(select lower(normalize(alias, NFKC)) from jsonb_array_elements_text(page->'aliases') alias), page->>'lang', (page->>'search_weight')::real,
        page->>'search_text', page->>'timeline', page,
        setweight(to_tsvector(${config}, page->>'title'), 'A') || setweight(to_tsvector(${config}, page->>'search_text'), 'B') || setweight(to_tsvector(${config}, page->>'timeline'), 'D')
        from jsonb_array_elements((select pages from pg_temp.brain_sync_payload)) page where ${published}
        on conflict (instance_id, repository_id, slug) do update set content_hash = excluded.content_hash, title = excluded.title, page_type = excluded.page_type,
        aliases = excluded.aliases, language = excluded.language, search_weight = excluded.search_weight, current_text = excluded.current_text,
        timeline = excluded.timeline, page_json = excluded.page_json, search_vector = excluded.search_vector`, data),
      query(`insert into companyos_brain.takes (instance_id, repository_id, page_slug, row_num, active, take_json, search_vector)
        select $1, $2, page->>'slug', (take->>'row_num')::int, (take->>'active')::boolean, take, to_tsvector(${config}, take->>'claim')
        from jsonb_array_elements((select pages from pg_temp.brain_sync_payload)) page cross join lateral jsonb_array_elements(page->'takes') take where ${published}`, data),
      query(`insert into companyos_brain.links (instance_id, repository_id, from_slug, occurrence, target, resolved_slug, relation, context)
        select $1, $2, page->>'slug', occurrence, link->>'target', link->>'resolved', link->>'relation', link->>'context'
        from jsonb_array_elements((select pages from pg_temp.brain_sync_payload)) page cross join lateral jsonb_array_elements(page->'links') with ordinality as links(link, occurrence) where ${published}`, data),
      query(`insert into companyos_brain.changes (instance_id, repository_id, generation, sequence, slug, kind, git_commit, indexed_at)
        select $1, $2, r.generation, r.sequence, change->>'slug', change->>'kind', r.git_commit, r.indexed_at
        from companyos_brain.revisions r cross join jsonb_array_elements($4::jsonb) change
        where r.instance_id = $1 and r.repository_id = $2 and r.publication_token = $3::uuid`, [scope.instance_id, scope.repository_id, token, changes]),
    ];
    if (Buffer.byteLength(JSON.stringify({ queries: wireQueries })) > 3_500_000) throw new BrainError("sync_bound", "Projection exceeds the maintained HTTP transaction bound; no checkpoint was advanced.");
    const results = await sql.transaction(statements);
    return results[2].length === 1;
  }
}
