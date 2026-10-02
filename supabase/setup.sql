-- Black & Gold: database-backed TEST ordering pilot.
-- Run this entire file in the Supabase SQL Editor. Safe to rerun.
-- Sample prices and menu must be confirmed before a production launch.
begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.staff_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table private.staff_members enable row level security;
revoke all on private.staff_members from public, anon, authenticated;

create table if not exists public.products (
  id bigint generated always as identity primary key,
  slug text unique not null,
  name text not null check (length(name) between 1 and 100),
  category text not null check (category in ('coffee','tea')),
  description text not null default '',
  price_cents integer not null check (price_cents between 50 and 100000),
  is_available boolean not null default true,
  sort_order integer not null default 0
);
create table if not exists public.product_styles (
  product_id bigint not null references public.products(id) on delete cascade,
  style text not null check (style in ('Hot','Iced')),
  extra_cents integer not null default 0 check (extra_cents between 0 and 100000),
  primary key (product_id,style)
);
create table if not exists public.store_settings (
  id boolean primary key default true check (id),
  is_accepting_orders boolean not null default true,
  testing_mode boolean not null default true,
  lead_minutes integer not null default 15 check (lead_minutes between 5 and 120),
  max_queue_orders integer not null default 40 check (max_queue_orders between 1 and 200),
  max_drinks_per_slot integer not null default 20 check (max_drinks_per_slot between 1 and 200),
  max_daily_orders integer not null default 60 check (max_daily_orders between 1 and 1000)
);
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number bigint generated always as identity (start with 1001) unique,
  customer_id uuid not null references auth.users(id),
  request_id uuid not null,
  request_fingerprint text not null,
  customer_name text not null check (length(customer_name) between 1 and 40),
  pickup_at timestamptz not null,
  status text not null default 'new' check (status in ('new','preparing','ready','collected','cancelled')),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','paid')),
  total_cents integer not null check (total_cents between 50 and 2000000),
  is_test boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (customer_id,request_id)
);
create table if not exists public.order_items (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id bigint not null references public.products(id),
  product_name text not null,
  style text not null,
  quantity integer not null check (quantity between 1 and 10),
  unit_price_cents integer not null check (unit_price_cents between 50 and 200000),
  unique (order_id,product_id,style)
);
create index if not exists orders_queue_idx on public.orders (status, pickup_at);
create index if not exists orders_customer_idx on public.orders (customer_id, created_at);
create index if not exists order_items_order_idx on public.order_items (order_id);

insert into public.products (slug,name,category,description,price_cents,sort_order) values
 ('latte','Latte','coffee','Espresso with smooth, steamed milk.',450,1),
 ('cappuccino','Cappuccino','coffee','A classic cup with a soft layer of foam.',450,2),
 ('cold-brew','Cold Brew','coffee','Slow-brewed coffee, served chilled.',400,3),
 ('vanilla-chai','Vanilla Chai','tea','Warming spice and fragrant black tea.',400,4),
 ('russian-earl-grey','Russian Earl Grey','tea','Citrus notes with a fragrant tea finish.',400,5),
 ('hojicha-latte','Hojicha Latte','tea','Roasted tea with a mellow, milky finish.',500,6)
on conflict (slug) do nothing;
insert into public.product_styles(product_id,style)
select p.id, s.style from public.products p
cross join (values ('Hot'),('Iced')) s(style)
where p.slug <> 'cold-brew' or s.style = 'Iced'
on conflict do nothing;
insert into public.store_settings(id) values (true) on conflict do nothing;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from private.staff_members where user_id = auth.uid());
$$;
revoke all on function public.is_staff() from public, anon, authenticated;
grant execute on function public.is_staff() to authenticated;

alter table public.products enable row level security;
alter table public.product_styles enable row level security;
alter table public.store_settings enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
revoke all on public.products, public.product_styles, public.store_settings,
  public.orders, public.order_items from public, anon, authenticated;
grant select on public.products, public.product_styles, public.store_settings to anon, authenticated;
grant select on public.orders, public.order_items to authenticated;

drop policy if exists catalog_read on public.products;
create policy catalog_read on public.products for select to anon, authenticated using (true);
drop policy if exists styles_read on public.product_styles;
create policy styles_read on public.product_styles for select to anon, authenticated using (true);
drop policy if exists settings_read on public.store_settings;
create policy settings_read on public.store_settings for select to anon, authenticated using (true);
drop policy if exists orders_read on public.orders;
create policy orders_read on public.orders for select to authenticated
using (customer_id = (select auth.uid()) or (select public.is_staff()));
drop policy if exists items_read on public.order_items;
create policy items_read on public.order_items for select to authenticated using (
  exists (select 1 from public.orders o where o.id = order_id)
);

-- A guest signs in anonymously first; the browser never supplies a trusted price.
-- All writes below use a fixed search_path and explicitly check caller identity.
create or replace function public.place_order(
  p_request_id uuid, p_customer_name text, p_pickup_at timestamptz, p_items jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  cfg public.store_settings%rowtype;
  existing public.orders%rowtype;
  fingerprint text;
  clean_name text := btrim(p_customer_name);
  line record;
  prod public.products%rowtype;
  surcharge integer;
  total integer := 0;
  drinks integer := 0;
  busy_drinks integer;
  new_order public.orders%rowtype;
  snapshot jsonb := '[]'::jsonb;
begin
  if actor is null then raise exception 'Please sign in before ordering.'; end if;
  if p_request_id is null or p_items is null or jsonb_typeof(p_items) <> 'array'
    or jsonb_array_length(p_items) not between 1 and 20 then
    raise exception 'Choose between 1 and 20 drink selections.';
  end if;
  if clean_name is null or length(clean_name) not between 1 and 40
    or clean_name ~ '[[:cntrl:]]' then raise exception 'Enter a collection name (1–40 characters).'; end if;
  if p_pickup_at is null then raise exception 'Select a pickup time.'; end if;
  fingerprint := md5(jsonb_build_object('name',clean_name,'pickup',p_pickup_at,'items',p_items)::text);
  -- Serialize submissions to enforce capacity and idempotency across devices.
  select * into cfg from public.store_settings where id = true for update;
  if not found then raise exception 'Store setup is incomplete.'; end if;
  select * into existing from public.orders where customer_id = actor and request_id = p_request_id;
  if found then
    if existing.request_fingerprint <> fingerprint then raise exception 'This checkout request was already used. Start a new order.'; end if;
    return jsonb_build_object('id',existing.id,'order_number',existing.order_number,
      'pickup_at',existing.pickup_at,'total_cents',existing.total_cents,'is_test',existing.is_test);
  end if;
  if not cfg.is_accepting_orders then raise exception 'Ordering is paused. Please check back shortly.'; end if;
  if not cfg.testing_mode then raise exception 'Live ordering is not enabled for this pilot.'; end if;
  if p_pickup_at < now() + make_interval(mins => cfg.lead_minutes) - interval '1 minute'
    or p_pickup_at > now() + interval '4 hours' then
    raise exception 'Choose a pickup time at least % minutes ahead and within 4 hours.',cfg.lead_minutes;
  end if;
  if extract(second from p_pickup_at) <> 0 or mod(extract(minute from p_pickup_at)::integer,15) <> 0 then
    raise exception 'Pickup times must use 15-minute slots.';
  end if;
  if (select count(*) from public.orders where customer_id = actor and created_at > now() - interval '10 minutes') >= 5
    or (select count(*) from public.orders where customer_id = actor and created_at > now() - interval '24 hours') >= 20 then
    raise exception 'Too many recent orders. Please try again later.';
  end if;
  if (select count(*) from public.orders where created_at > now() - interval '24 hours') >= cfg.max_daily_orders then
    raise exception 'The pilot order limit has been reached for today.';
  end if;
  if (select count(*) from public.orders where status in ('new','preparing','ready')) >= cfg.max_queue_orders then
    raise exception 'The order queue is full. Please try again later.';
  end if;
  if (select count(*) from jsonb_to_recordset(p_items) as x(product_id bigint,style text,quantity integer)) <>
    (select count(distinct (x.product_id,x.style)) from jsonb_to_recordset(p_items) as x(product_id bigint,style text,quantity integer)) then
    raise exception 'Combine duplicate drinks into a single quantity.';
  end if;
  for line in select * from jsonb_to_recordset(p_items) as x(product_id bigint,style text,quantity integer) order by product_id,style loop
    if line.quantity is null or line.quantity not between 1 and 10 then raise exception 'Each drink quantity must be between 1 and 10.'; end if;
    select * into prod from public.products where id = line.product_id for share;
    if not found or not prod.is_available then raise exception 'A selected drink is unavailable. Refresh your menu.'; end if;
    select extra_cents into surcharge from public.product_styles where product_id = prod.id and style = line.style for share;
    if not found then raise exception 'A selected drink option is unavailable.'; end if;
    drinks := drinks + line.quantity;
    total := total + (prod.price_cents + surcharge) * line.quantity;
    snapshot := snapshot || jsonb_build_array(jsonb_build_object('product_id',prod.id,'product_name',prod.name,
      'style',line.style,'quantity',line.quantity,'unit_price_cents',prod.price_cents+surcharge));
  end loop;
  if drinks > 20 then raise exception 'Please limit each order to 20 drinks.'; end if;
  select coalesce(sum(i.quantity),0) into busy_drinks from public.orders o
    join public.order_items i on i.order_id = o.id where o.pickup_at = p_pickup_at and o.status <> 'cancelled';
  if drinks + busy_drinks > cfg.max_drinks_per_slot then raise exception 'That pickup slot is full. Choose a later time.'; end if;
  insert into public.orders(customer_id,request_id,request_fingerprint,customer_name,pickup_at,total_cents,is_test)
    values(actor,p_request_id,fingerprint,clean_name,p_pickup_at,total,true) returning * into new_order;
  insert into public.order_items(order_id,product_id,product_name,style,quantity,unit_price_cents)
    select new_order.id,x.product_id,x.product_name,x.style,x.quantity,x.unit_price_cents
    from jsonb_to_recordset(snapshot) as x(product_id bigint,product_name text,style text,quantity integer,unit_price_cents integer);
  return jsonb_build_object('id',new_order.id,'order_number',new_order.order_number,'pickup_at',new_order.pickup_at,
    'total_cents',new_order.total_cents,'is_test',new_order.is_test);
end;
$$;
revoke all on function public.place_order(uuid,text,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function public.place_order(uuid,text,timestamptz,jsonb) to authenticated;

create or replace function public.staff_set_order_status(p_order_id uuid,p_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare current_status text;
begin
  if not public.is_staff() then raise exception 'Staff access required.'; end if;
  select status into current_status from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order not found.'; end if;
  if not ((current_status='new' and p_status in ('preparing','cancelled'))
    or (current_status='preparing' and p_status in ('ready','cancelled'))
    or (current_status='ready' and p_status in ('collected','cancelled'))) then
    raise exception 'Order status changed. Refresh the dashboard.';
  end if;
  update public.orders set status=p_status,
    payment_status=case when p_status='collected' then 'paid' else payment_status end,
    updated_at=now() where id=p_order_id;
end;
$$;
revoke all on function public.staff_set_order_status(uuid,text) from public, anon, authenticated;
grant execute on function public.staff_set_order_status(uuid,text) to authenticated;

create or replace function public.staff_set_product(p_product_id bigint,p_available boolean,p_price_cents integer)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception 'Staff access required.'; end if;
  if p_available is null or p_price_cents is null or p_price_cents not between 50 and 100000 then raise exception 'Enter a valid price and availability.'; end if;
  update public.products set is_available=p_available,price_cents=p_price_cents where id=p_product_id;
  if not found then raise exception 'Drink not found.'; end if;
end;
$$;
revoke all on function public.staff_set_product(bigint,boolean,integer) from public, anon, authenticated;
grant execute on function public.staff_set_product(bigint,boolean,integer) to authenticated;

create or replace function public.staff_pause_orders(p_paused boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception 'Staff access required.'; end if;
  if p_paused is null then raise exception 'Choose an ordering state.'; end if;
  update public.store_settings set is_accepting_orders=not p_paused where id=true;
end;
$$;
revoke all on function public.staff_pause_orders(boolean) from public, anon, authenticated;
grant execute on function public.staff_pause_orders(boolean) to authenticated;

notify pgrst, 'reload schema';
commit;
