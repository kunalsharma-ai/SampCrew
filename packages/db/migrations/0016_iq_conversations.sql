-- CREW IQ conversations: each person's own questions and the answers they got, so the panel can show them again
-- and a follow-up question can continue the previous one. Only the asker reads them (the API filters by membership);
-- they can delete one or all.

create table iq_conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  membership_id uuid not null,
  title text not null check (length(title) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create index iq_conversations_member on iq_conversations (tenant_id, membership_id, updated_at desc);

create table iq_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  conversation_id uuid not null,
  membership_id uuid not null,
  question text not null check (length(question) between 1 and 500),
  intent text not null,
  match jsonb not null,
  answer jsonb not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, conversation_id) references iq_conversations (tenant_id, id) on delete cascade
);
create index iq_messages_conversation on iq_messages (tenant_id, conversation_id, created_at);

do $$
declare t text;
begin
  foreach t in array array['iq_conversations', 'iq_messages'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())', t);
    execute format('grant select, insert, update, delete on %I to crew_app', t);
    execute format('grant select, insert, update, delete on %I to crew_platform', t);
  end loop;
end $$;
