-- Derived knowledge only. The existing control and Records schemas remain authoritative for their own state.
create schema if not exists companyos_brain;
create table if not exists companyos_brain.revisions (
  instance_id text not null, repository_id text not null,
  git_commit text not null check (git_commit ~ '^[a-f0-9]{40}$'),
  configuration_digest text not null check (configuration_digest ~ '^[a-f0-9]{64}$'),
  generation uuid not null, sequence bigint not null check (sequence >= 0),
  indexed_at timestamptz not null, publication_token uuid not null,
  primary key (instance_id, repository_id)
);
create table if not exists companyos_brain.pages (
  instance_id text not null, repository_id text not null, slug text not null,
  content_hash text not null, title text not null, page_type text not null,
  aliases text[] not null, language text not null, search_weight real not null check (search_weight > 0 and search_weight <= 1),
  current_text text not null, timeline text not null, page_json jsonb not null,
  search_vector tsvector not null,
  primary key (instance_id, repository_id, slug),
  foreign key (instance_id, repository_id) references companyos_brain.revisions(instance_id, repository_id) on delete cascade
);
create index if not exists brain_pages_search_idx on companyos_brain.pages using gin(search_vector);
create index if not exists brain_pages_title_idx on companyos_brain.pages(instance_id, repository_id, lower(title));
create index if not exists brain_pages_aliases_idx on companyos_brain.pages using gin(aliases);
create table if not exists companyos_brain.takes (
  instance_id text not null, repository_id text not null, page_slug text not null, row_num integer not null check (row_num > 0),
  active boolean not null, take_json jsonb not null, search_vector tsvector not null,
  primary key (instance_id, repository_id, page_slug, row_num),
  foreign key (instance_id, repository_id, page_slug) references companyos_brain.pages(instance_id, repository_id, slug) on delete cascade
);
create index if not exists brain_takes_search_idx on companyos_brain.takes using gin(search_vector) where active;
create table if not exists companyos_brain.links (
  instance_id text not null, repository_id text not null, from_slug text not null,
  occurrence integer not null, target text not null, resolved_slug text, relation text not null, context text not null,
  primary key (instance_id, repository_id, from_slug, occurrence),
  foreign key (instance_id, repository_id, from_slug) references companyos_brain.pages(instance_id, repository_id, slug) on delete cascade
);
create index if not exists brain_links_target_idx on companyos_brain.links(instance_id, repository_id, resolved_slug);
create table if not exists companyos_brain.changes (
  instance_id text not null, repository_id text not null, generation uuid not null,
  sequence bigint not null, slug text not null, kind text not null check (kind in ('created','updated','removed')),
  git_commit text not null, indexed_at timestamptz not null,
  primary key (instance_id, repository_id, generation, sequence, slug),
  foreign key (instance_id, repository_id) references companyos_brain.revisions(instance_id, repository_id) on delete cascade
);
create index if not exists brain_changes_time_idx on companyos_brain.changes(instance_id, repository_id, indexed_at, sequence, slug);
