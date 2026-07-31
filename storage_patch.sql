-- ЕГОРИЯ ONLINE — ДОПОЛНЕНИЕ ДЛЯ АВАТАРОВ И ВЛОЖЕНИЙ
-- Запусти этот файл целиком в Supabase SQL Editor ОДИН РАЗ.

-- 1. Публичный bucket только для аватаров.
insert into storage.buckets (id, name, public, file_size_limit)
values ('egoria-avatars', 'egoria-avatars', true, 5242880)
on conflict (id) do update
set public = true, file_size_limit = 5242880;

drop policy if exists "Avatar owners can upload" on storage.objects;
drop policy if exists "Avatar owners can update" on storage.objects;
drop policy if exists "Avatar owners can delete" on storage.objects;

create policy "Avatar owners can upload"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'egoria-avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "Avatar owners can update"
on storage.objects for update to authenticated
using (
  bucket_id = 'egoria-avatars'
  and owner_id = auth.uid()::text
)
with check (
  bucket_id = 'egoria-avatars'
  and owner_id = auth.uid()::text
);

create policy "Avatar owners can delete"
on storage.objects for delete to authenticated
using (
  bucket_id = 'egoria-avatars'
  and owner_id = auth.uid()::text
);

-- 2. Участники переписки могут читать вложения этой переписки.
-- Путь файла в приложении: user_id/conversation_id/имя_файла
drop policy if exists "Users can view own uploaded files" on storage.objects;
drop policy if exists "Conversation members can view attachments" on storage.objects;

create policy "Conversation members can view attachments"
on storage.objects for select to authenticated
using (
  bucket_id = 'egoria-files'
  and (
    owner_id = auth.uid()::text
    or (
      array_length(storage.foldername(name), 1) >= 2
      and (storage.foldername(name))[2] ~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      and public.is_conversation_member(
        ((storage.foldername(name))[2])::uuid,
        auth.uid()
      )
    )
  )
);

select 'Дополнение Storage успешно установлено' as result;
