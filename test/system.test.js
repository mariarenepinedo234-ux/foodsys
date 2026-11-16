import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, businessDate, localHour } from '../server/store.js';
import { createApp } from '../server/index.js';

const fixed='2026-11-13T16:00:00.000Z'; // Noon in Bolivia
function store(){return createStore(':memory:',{now:()=>new Date(fixed)});}
function combo(s,overrides={}){const menu=s.menu(s.today());return {date:s.today(),customer:'Ana',type:'reservation',lines:[{kind:'combo',soupId:menu.items.find(i=>i.kind==='soup').id,mainId:menu.items.find(i=>i.kind==='main').id,quantity:1}],...overrides};}
test('business clock uses Bolivia and reconciles automatic opening and closing',()=>{
 assert.equal(businessDate(new Date('2026-11-14T02:00:00Z')),'2026-11-13');assert.equal(localHour(new Date('2026-11-14T02:00:00Z')),22);
 let clock=new Date(fixed);const s=createStore(':memory:',{now:()=>clock});assert.equal(s.snapshot(s.today()).cash.closed_at,null);
 clock=new Date('2026-11-13T22:00:00Z');s.reconcile();assert.ok(s.snapshot(s.today()).cash.closed_at);
 clock=new Date('2026-11-14T15:00:00Z');s.reconcile();assert.equal(s.snapshot(s.today()).cash.closed_at,null);assert.ok(s.get('SELECT closed_at FROM cash_days WHERE date=?','2026-11-13').closed_at);s.db.close();
});
test('complete includes refreshment automatically and reserves soup and chosen main; payment and kitchen do not double deduct',()=>{
 const s=store(),before=s.menu(s.today()),o=s.createOrder(combo(s));assert.equal(o.total,2500);
 const after=s.menu(s.today());for(const kind of ['soup','main']){const item=before.items.find(i=>i.kind===kind);assert.equal(after.items.find(i=>i.id===item.id).available,item.available-1);}
 assert.match(s.orders(s.today())[0].lines[0].label,/vaso de refresco incluido/);
 const drink=before.items.find(i=>i.kind==='drink');assert.equal(after.items.find(i=>i.id===drink.id).available,drink.available);
 const other=before.items.filter(i=>i.kind==='main')[1];assert.equal(after.items.find(i=>i.id===other.id).available,other.available);
 s.transaction(()=>s.pay(o.id,'qr'));s.transition(o.id,'queued','cashier');assert.throws(()=>s.transition(o.id,'preparing','cashier'),/corresponden a cocina/);s.transition(o.id,'preparing','kitchen');s.transition(o.id,'ready','kitchen');s.transition(o.id,'delivered','kitchen');assert.deepEqual(s.menu(s.today()),after);assert.throws(()=>s.pay(o.id,'cash'),/ya está pagado/);s.db.close();
});
test('stock shortage rolls back all allocations, lines and payments',()=>{
 const s=store(),menu=s.menu(s.today()),body=combo(s);body.lines[0].quantity=51;
 assert.throws(()=>s.createOrder(body),/No alcanza/);assert.deepEqual(s.menu(s.today()),menu);assert.equal(s.all('SELECT * FROM orders').length,0);assert.equal(s.all('SELECT * FROM payments').length,0);s.db.close();
});
test('singles, repeated lines, cancellation and paid cancellation guard',()=>{
 const s=store(),i=s.menu(s.today()).items.find(i=>i.kind==='soup');const o=s.createOrder({date:s.today(),customer:'Luis',type:'reservation',lines:[{itemId:i.id,quantity:2},{itemId:i.id,quantity:3}]});assert.equal(s.get('SELECT used FROM items WHERE id=?',i.id).used,5);
 s.transition(o.id,'cancelled','cashier');assert.equal(s.get('SELECT used FROM items WHERE id=?',i.id).used,0);assert.throws(()=>s.transition(o.id,'cancelled','cashier'),/no es válido/);
 const paid=s.createOrder(combo(s,{payment:'cash'}));assert.throws(()=>s.transition(paid.id,'cancelled','admin'),/devolución/);s.db.close();
});
test('closed till blocks payments and cash sales but permits unpaid future reservations',()=>{
 const s=store();s.run('UPDATE cash_days SET closed_at=? WHERE date=?',fixed,s.today());assert.throws(()=>s.createOrder(combo(s,{type:'sale',payment:'cash'})),/cerrada/);assert.equal(s.all('SELECT * FROM orders').length,0);
 s.saveMenu({date:'2026-11-14',combo_price:25,published:true,items:[{name:'Sopa',kind:'soup',price:10,stock:10}]});const i=s.menu('2026-11-14').items[0];const o=s.createOrder({date:'2026-11-14',customer:'Ana',type:'reservation',lines:[{itemId:i.id,quantity:1}]});assert.equal(o.status,'reserved');assert.throws(()=>s.transition(o.id,'queued','cashier'),/hoy/);s.db.close();
});
test('daily reports separate cash and QR and subtract expenses in integer cents',()=>{
 const s=store();s.createOrder(combo(s,{payment:'cash'}));s.createOrder(combo(s,{payment:'qr'}));s.run('INSERT INTO expenses(date,description,amount,method,created_at) VALUES (?,?,?,?,?)',s.today(),'Verduras',850,'cash',fixed);
 const r=s.report(s.today(),s.today());assert.equal(r.income,5000);assert.equal(r.cash,2500);assert.equal(r.qr,2500);assert.equal(r.balance,4150);assert.equal(r.count,2);s.db.close();
});
test('menu edits cannot reduce reserved portions or remove historical items; previous order prices remain',()=>{
 const s=store();const o=s.createOrder(combo(s));const before=s.menu(s.today());const body={date:s.today(),combo_price:30,published:true,items:before.items.filter(i=>!i.productId).map(i=>({...i,price:i.price/100}))};body.items[0].stock=0;assert.throws(()=>s.saveMenu(body),/comprometidas/);assert.deepEqual(s.menu(s.today()),before);
 body.items[0].stock=50;s.saveMenu(body);assert.equal(s.orders(s.today()).find(i=>i.id===o.id).total,2500);s.db.close();
});
test('public reservation cannot mark itself paid or bypass publication and quantity validation',()=>{
 const s=store();const order=s.createOrder(combo(s,{phone:'70000000',payment:'qr',type:'sale'}),'public');assert.equal(order.status,'reserved');assert.equal(s.all('SELECT * FROM payments').length,0);
 s.run('UPDATE days SET published=0');assert.throws(()=>s.createOrder(combo(s),'public'),/publicado/);s.run('UPDATE days SET published=1');const body=combo(s);body.lines[0].quantity=-1;assert.throws(()=>s.createOrder(body),/Cantidad/);s.db.close();
});
let server,base,s;
before(async()=>{s=store();server=createApp(s).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}/api`;});
after(async()=>{await new Promise(r=>server.close(r));s.db.close();});
async function request(path,body,cookie){const res=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};}
test('HTTP authentication, role permissions, public booking, staff payment and logout',async()=>{
 assert.equal((await request('/state')).status,401);assert.equal((await request('/login',{username:'admin',password:'wrong'})).status,401);
 const admin=await request('/login',{username:'admin',password:'admin123'}),cashier=await request('/login',{username:'cajero',password:'cajero123'}),kitchen=await request('/login',{username:'cocina',password:'cocina123'});assert.equal(admin.status,200);assert.ok(admin.cookie);
 assert.equal((await request('/menu',{},cashier.cookie)).status,403);assert.equal((await request('/expenses',{description:'x',amount:1,method:'cash'},kitchen.cookie)).status,403);assert.equal((await request('/reports?from=2026-11-13&to=2026-11-13',undefined,cashier.cookie)).status,403);
 assert.equal((await request('/public/menu?date=2026-11-13')).data.menu.published,1);
 const booking=await request('/public/reservations',combo(s,{phone:'70000000',payment:'qr'}));assert.equal(booking.status,201);
 assert.equal((await request(`/orders/${booking.data.id}/pay`,{method:'cash'},cashier.cookie)).status,200);
 assert.equal((await request(`/orders/${booking.data.id}/pay`,{method:'cash'},cashier.cookie)).status,409);
 const kitchenState=await request('/state',undefined,kitchen.cookie);assert.equal(kitchenState.data.report,undefined);
 assert.equal((await request('/logout',{},cashier.cookie)).status,200);assert.equal((await request('/me',undefined,cashier.cookie)).status,401);
});
test('HTTP cash workflow guards opening balance and stores reconciled closing',async()=>{
 const admin=await request('/login',{username:'admin',password:'admin123'});assert.equal((await request('/cash/opening',{amount:100},admin.cookie)).status,400);
 assert.equal((await request('/expenses',{description:'Compras',amount:5,method:'cash'},admin.cookie)).status,200);
 assert.equal((await request('/cash/close',{counted:20,note:'Sin diferencia'},admin.cookie)).status,200);
 assert.equal((await request('/expenses',{description:'Compras',amount:5,method:'cash'},admin.cookie)).status,409);
 assert.equal((await request('/state',undefined,admin.cookie)).data.cash.counted,2000);
});

test('combo does not need a drink product and rejects a stale checkout price',()=>{
 const s=store();s.run('UPDATE products SET active=0');
 const order=s.createOrder(combo(s));assert.equal(order.total,2500);assert.match(s.orders(s.today())[0].lines[0].label,/vaso de refresco incluido/);
 assert.throws(()=>s.createOrder(combo(s,{expectedTotal:1})),/precio del menú cambió/);assert.equal(s.all('SELECT * FROM orders').length,1);s.db.close();
});
test('concurrent HTTP reservations cannot oversell the final portion',async()=>{
 const isolated=store(),item=isolated.menu(isolated.today()).items.find(i=>i.kind==='extra');isolated.run('UPDATE items SET stock=1 WHERE id=?',item.id);
 const api=createApp(isolated),srv=api.listen(0,'127.0.0.1');await new Promise(r=>srv.once('listening',r));
 try{const url=`http://127.0.0.1:${srv.address().port}/api/public/reservations`,body={date:isolated.today(),customer:'Prueba simultánea',phone:'70000000',lines:[{itemId:item.id,quantity:1}]};const responses=await Promise.all([1,2].map(()=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})));assert.deepEqual(responses.map(r=>r.status).sort(),[201,409]);assert.equal(isolated.get('SELECT used FROM items WHERE id=?',item.id).used,1);await Promise.all(responses.map(r=>r.json()));}
 finally{await new Promise(r=>srv.close(r));isolated.db.close();}
});

test('unnamed staff orders get the default without changing named or public orders',()=>{
 const s=store();s.createOrder(combo(s,{customer:'  '}));s.createOrder(combo(s,{customer:' Beatriz '}));
 assert.deepEqual(s.orders(s.today()).map(o=>o.customer),['Beatriz','Cliente sin nombre']);
 assert.throws(()=>s.createOrder(combo(s,{customer:''}),'public'),/nombre/);s.db.close();
});

test('photos survive saving, omission and restart; migration preserves existing sales and stock',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'foodsys-migration-')),path=join(dir,'legacy.sqlite');let s;
 try{
  s=createStore(path,{now:()=>new Date(fixed)});s.createOrder(combo(s,{payment:'qr'}));
  const orders=s.orders(s.today()),menu=s.menu(s.today()),report=s.report(s.today(),s.today());
  s.db.exec('ALTER TABLE items DROP COLUMN photo');s.db.close();
  s=createStore(path,{now:()=>new Date(fixed)});
  assert.deepEqual(s.orders(s.today()),orders);assert.deepEqual(s.menu(s.today()),menu);assert.deepEqual(s.report(s.today(),s.today()),report);
  const photo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
  const body={date:s.today(),combo_price:25,published:true,items:menu.items.filter(i=>!i.productId).map(i=>({...i,price:i.price/100,photo}))};s.saveMenu(body);
  body.items.forEach(i=>delete i.photo);s.saveMenu(body);assert.equal(s.menu(s.today()).items[0].photo,photo);
  body.items[0].photo='data:image/svg+xml;base64,PHN2Zz4=';assert.throws(()=>s.saveMenu(body),/Foto inválida/);
  s.db.close();s=createStore(path,{now:()=>new Date(fixed)});assert.equal(s.menu(s.today()).items[0].photo,photo);assert.deepEqual(s.orders(s.today()),orders);
  body.items[0].photo='';s.saveMenu(body);assert.equal(s.menu(s.today()).items[0].photo,'');
 }finally{s?.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('HTTP menu accepts photo payloads above the old 100 KB limit and exposes them publicly',async()=>{
 const isolated=store(),app=createApp(isolated),srv=app.listen(0,'127.0.0.1');await new Promise(r=>srv.once('listening',r));
 const url=`http://127.0.0.1:${srv.address().port}`;
 try{
  const login=await fetch(url+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'admin123'})});await login.json();
  const photo='data:image/jpeg;base64,'+'A'.repeat(120000),menu=isolated.menu(isolated.today());
  const res=await fetch(url+'/api/menu',{method:'POST',headers:{'Content-Type':'application/json',Cookie:login.headers.get('set-cookie').split(';')[0]},body:JSON.stringify({date:isolated.today(),combo_price:25,published:true,items:menu.items.filter(i=>!i.productId).map((i,index)=>({...i,price:i.price/100,photo:index?'':photo}))})});
  assert.equal(res.status,200);await res.json();const publicMenu=await fetch(url+'/api/public/menu?date='+isolated.today());assert.equal((await publicMenu.json()).menu.items[0].photo,photo);
  const page=await fetch(url+'/');assert.equal(page.status,200);assert.match(await page.text(),/id="app"/);
 }finally{await new Promise(r=>srv.close(r));isolated.db.close();}
});

test('legacy refreshment stock and orders survive menu edits and restart; cancellation restores original allocations',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'foodsys-legacy-drink-')),path=join(dir,'foodsys.sqlite');let s;
 try{
  s=createStore(path,{now:()=>new Date(fixed)});
  const drinkId=Number(s.run('INSERT INTO items(date,name,kind,price,stock,used,combo_eligible) VALUES (?,?,?,?,?,?,?)',s.today(),'Refresco del día','drink',300,60,1,1).lastInsertRowid);
  const order=s.createOrder(combo(s));s.run('INSERT INTO allocations VALUES (?,?,?)',order.id,drinkId,1);
  s.run('UPDATE lines SET label=? WHERE order_id=?','Completo antiguo · sopa + segundo + refresco',order.id);
  const orders=s.orders(s.today()),legacy=s.get('SELECT * FROM items WHERE id=?',drinkId);
  s.db.close();s=createStore(path,{now:()=>new Date(fixed)});
  assert.deepEqual(s.orders(s.today()),orders);assert.ok(!s.menu(s.today()).items.some(i=>i.id===drinkId));
  assert.throws(()=>s.createOrder({date:s.today(),type:'reservation',lines:[{itemId:drinkId,quantity:1}]}),/solo se sirve incluido/);
  const menu=s.menu(s.today());s.saveMenu({date:s.today(),combo_price:30,published:true,items:menu.items.filter(i=>!i.productId).map(i=>({...i,price:i.price/100}))});
  assert.deepEqual(s.get('SELECT * FROM items WHERE id=?',drinkId),legacy);assert.deepEqual(s.orders(s.today()),orders);
  const soda=menu.items.find(i=>i.kind==='drink');const single=s.createOrder({date:s.today(),type:'reservation',lines:[{kind:'product',productId:soda.productId,quantity:1}]});assert.equal(single.total,soda.price);
  s.transition(order.id,'cancelled','cashier');assert.equal(s.get('SELECT used FROM items WHERE id=?',drinkId).used,0);
 }finally{s?.db.close();rmSync(dir,{recursive:true,force:true});}
});
