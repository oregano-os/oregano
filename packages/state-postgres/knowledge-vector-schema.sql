-- Optional derived hybrid-retrieval projection. Apply only where pgvector is
-- available; lexical retrieval remains the required degradation path.
create extension if not exists vector;

create table if not exists companyos_knowledge.fragment_embeddings (
  snapshot_hash text not null references companyos_knowledge.snapshots(snapshot_hash) on delete cascade,
  fragment_id text not null,
  adapter_id text not null,
  adapter_version text not null,
  embedding vector(256) not null,
  primary key (snapshot_hash, fragment_id, adapter_id, adapter_version),
  foreign key (snapshot_hash, fragment_id) references companyos_knowledge.fragments(snapshot_hash, fragment_id) on delete cascade
);
create index if not exists knowledge_fragment_embeddings_hnsw_idx
  on companyos_knowledge.fragment_embeddings using hnsw (embedding vector_cosine_ops);
