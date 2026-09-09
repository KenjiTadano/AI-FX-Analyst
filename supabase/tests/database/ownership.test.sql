-- Run with `supabase test db` against a disposable local Supabase instance.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();
insert into auth.users(id, email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','task008-a@example.invalid'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','task008-b@example.invalid');
select is((select count(*)::integer from public.profiles where id in ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')), 2, 'Auth trigger creates profiles');
select is((select trade_unit from public.user_settings where user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 1000, 'Settings default trade unit');
insert into public.trades(id,user_id,pair,side,status,quantity,entry_price,opened_at) values
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','USD/JPY','long','open',1000,153.5,now()),
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','GBP/JPY','short','open',1000,193.5,now());
set local role authenticated;
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select is((select count(*)::integer from public.profiles), 1, 'Profile reads owner only');
select is((select count(*)::integer from public.user_settings), 1, 'Settings reads owner only');
select is((select count(*)::integer from public.trades), 1, 'Trades reads owner only');
with changed as (update public.trades set notes='foreign edit' where user_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' returning id) select is(count(*)::integer, 0, 'Cannot update foreign trade') from changed;
with changed as (delete from public.trades where user_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' returning id) select is(count(*)::integer, 0, 'Cannot delete foreign trade') from changed;
with changed as (update public.user_settings set current_capital=1 where user_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' returning user_id) select is(count(*)::integer, 0, 'Cannot update foreign settings') from changed;
with changed as (delete from public.user_settings where user_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' returning user_id) select is(count(*)::integer, 0, 'Cannot delete foreign settings') from changed;
with changed as (update public.profiles set display_name='foreign' where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' returning id) select is(count(*)::integer, 0, 'Cannot update foreign profile') from changed;
with changed as (delete from public.profiles where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' returning id) select is(count(*)::integer, 0, 'Cannot delete foreign profile') from changed;
select throws_ok($$insert into public.trades(user_id,pair,side,status,quantity,entry_price,opened_at) values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','USD/JPY','long','open',1000,153.5,now())$$, '42501', null, 'Cannot insert for another owner');
select throws_ok($$insert into public.user_settings(user_id) values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')$$, '42501', null, 'Cannot insert foreign settings');
select throws_ok($$insert into public.profiles(id) values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')$$, '42501', null, 'Cannot insert foreign profile');
select throws_ok($$update public.user_settings set risk_percent=11$$, '23514', null, 'Risk cap is enforced by DB');
select lives_ok($$update public.trades set status='closed', exit_price=154, closed_at=clock_timestamp() where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'$$, 'Owner can close trade');
select is((select realized_pnl from public.trades), 500::numeric, 'PnL computed by DB');
select is((select version from public.trades), 2::bigint, 'Update increments version');
select is(public.import_local_trades('[{"user_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","local_trade_id":"legacy-1","pair":"EUR/JPY","side":"long","status":"open","quantity":100,"entry_price":160,"opened_at":"2026-09-08T03:00:00Z","created_at":"2026-09-08T03:00:00Z","updated_at":"2026-09-08T03:00:00Z"}]'), 1, 'First legacy import inserts');
select is(public.import_local_trades('[{"user_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","local_trade_id":"legacy-1","pair":"EUR/JPY","side":"long","status":"open","quantity":100,"entry_price":160,"opened_at":"2026-09-08T03:00:00Z","created_at":"2026-09-08T03:00:00Z","updated_at":"2026-09-08T03:00:00Z"}]'), 0, 'Repeated legacy import is idempotent');
select lives_ok($$delete from public.trades where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'$$, 'Owner can delete own trade');
select set_config('request.jwt.claim.sub','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true);
select is((select count(*)::integer from public.trades), 1, 'Other account cannot see imported rows');
reset role;
set local role anon;
select set_config('request.jwt.claim.sub','',true);
select throws_ok('select * from public.trades', '42501', null, 'Anon cannot read trades');
select throws_ok('select * from public.user_settings', '42501', null, 'Anon cannot read settings');
select throws_ok('select * from public.profiles', '42501', null, 'Anon cannot read profiles');
reset role;
select * from finish();
rollback;
