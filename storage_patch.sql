-- EGORIA ONLINE — UPGRADE PACK
-- Запусти этот файл ЦЕЛИКОМ один раз в Supabase -> SQL Editor -> Run.
-- Скрипт идемпотентный: его можно повторно запустить.

-- =========================================================
-- 1. PROFILES: безопасное чтение и изменение своего профиля
-- =========================================================

alter table public.profiles enable row level security;

drop policy if exists "egoria_profiles_select" on public.profiles;
drop policy if exists "egoria_profiles_insert_own" on public.profiles;
drop policy if exists "egoria_profiles_update_own" on public.profiles;

create policy "egoria_profiles_select"
on public.profiles
for select
to authenticated
using (true);

create policy "egoria_profiles_insert_own"
on public.profiles
for insert
to authenticated
with check (id = auth.uid());

create policy "egoria_profiles_update_own"
on public.profiles
for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

-- =========================================================
-- 2. MESSAGES: ответы, "удалить у меня", прочитано
-- =========================================================

alter table public.messages
  add column if not exists reply_to uuid,
  add column if not exists hidden_for uuid[] not null default '{}'::uuid[],
  add column if not exists read_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'messages_reply_to_fkey'
      and conrelid = 'public.messages'::regclass
  ) then
    alter table public.messages
      add constraint messages_reply_to_fkey
      foreign key (reply_to)
      references public.messages(id)
      on delete set null;
  end if;
end $$;

alter table public.messages enable row level security;

drop policy if exists "egoria_message_sender_update" on public.messages;

create policy "egoria_message_sender_update"
on public.messages
for update
to authenticated
using (sender_id = auth.uid())
with check (sender_id = auth.uid());

-- Удалить сообщение только у себя, не давая получателю менять текст сообщения.
create or replace function public.hide_message_for_me(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conversation_id uuid;
begin
  select conversation_id
    into v_conversation_id
  from public.messages
  where id = p_message_id;

  if v_conversation_id is null then
    raise exception 'Message not found';
  end if;

  if not public.is_conversation_member(v_conversation_id, auth.uid()) then
    raise exception 'Not allowed';
  end if;

  update public.messages
  set hidden_for = case
    when auth.uid() = any(coalesce(hidden_for, '{}'::uuid[]))
      then coalesce(hidden_for, '{}'::uuid[])
    else array_append(coalesce(hidden_for, '{}'::uuid[]), auth.uid())
  end
  where id = p_message_id;
end;
$$;

grant execute on function public.hide_message_for_me(uuid) to authenticated;

-- Удалить СВОЁ сообщение у всех участников диалога.
-- SECURITY DEFINER нужен, чтобы действие не ломалось из-за пересечения RLS-политик,
-- но внутри функции жёстко проверяется, что auth.uid() = sender_id.
create or replace function public.delete_message_for_everyone(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sender_id uuid;
begin
  select sender_id
    into v_sender_id
  from public.messages
  where id = p_message_id;

  if v_sender_id is null then
    raise exception 'Message not found';
  end if;

  if v_sender_id <> auth.uid() then
    raise exception 'You can delete for everyone only your own message';
  end if;

  update public.messages
  set body = '',
      attachment_path = null,
      attachment_name = null,
      attachment_type = null,
      attachment_size = null,
      deleted_at = now(),
      edited_at = null
  where id = p_message_id
    and sender_id = auth.uid();
end;
$$;

grant execute on function public.delete_message_for_everyone(uuid) to authenticated;

-- Отметить входящие сообщения открытого диалога прочитанными.
create or replace function public.mark_conversation_read(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_conversation_member(p_conversation_id, auth.uid()) then
    raise exception 'Not allowed';
  end if;

  update public.messages
  set read_at = coalesce(read_at, now())
  where conversation_id = p_conversation_id
    and sender_id <> auth.uid()
    and read_at is null
    and deleted_at is null;
end;
$$;

grant execute on function public.mark_conversation_read(uuid) to authenticated;

-- =========================================================
-- 3. AVATARS STORAGE
-- =========================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('egoria-avatars', 'egoria-avatars', true, 5242880)
on conflict (id) do update
set public = true,
    file_size_limit = 5242880;

drop policy if exists "egoria_avatar_insert" on storage.objects;
drop policy if exists "egoria_avatar_update" on storage.objects;
drop policy if exists "egoria_avatar_delete" on storage.objects;

create policy "egoria_avatar_insert"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'egoria-avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "egoria_avatar_update"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'egoria-avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'egoria-avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "egoria_avatar_delete"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'egoria-avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- =========================================================
-- 4. CHAT FILES STORAGE
-- Путь: user_id/conversation_id/file.ext
-- =========================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('egoria-files', 'egoria-files', false, 26214400)
on conflict (id) do update
set public = false,
    file_size_limit = 26214400;

drop policy if exists "egoria_files_insert" on storage.objects;
drop policy if exists "egoria_files_select" on storage.objects;
drop policy if exists "egoria_files_delete" on storage.objects;

create policy "egoria_files_insert"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'egoria-files'
  and array_length(storage.foldername(name), 1) >= 2
  and (storage.foldername(name))[1] = auth.uid()::text
  and public.is_conversation_member(
    ((storage.foldername(name))[2])::uuid,
    auth.uid()
  )
);

create policy "egoria_files_select"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'egoria-files'
  and array_length(storage.foldername(name), 1) >= 2
  and public.is_conversation_member(
    ((storage.foldername(name))[2])::uuid,
    auth.uid()
  )
);

create policy "egoria_files_delete"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'egoria-files'
  and (storage.foldername(name))[1] = auth.uid()::text
);

select 'Egoria upgrade installed successfully' as result;
