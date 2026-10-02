-- FIRST: Supabase Authentication -> Users -> Add user.
-- Create an email/password user and ensure their email is confirmed.
-- THEN: Replace YOUR_STAFF_EMAIL below and run this in SQL Editor.
-- Do not paste the user's password here or put it in GitHub.
do $$
declare staff_email text := 'YOUR_STAFF_EMAIL'; staff_id uuid;
begin
  select id into staff_id from auth.users where lower(email)=lower(staff_email) and not coalesce(is_anonymous,false);
  if staff_id is null then raise exception 'Create and confirm the staff user in Authentication first.'; end if;
  insert into private.staff_members(user_id) values(staff_id) on conflict do nothing;
end;
$$;
