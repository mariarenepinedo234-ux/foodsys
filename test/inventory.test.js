import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../server/store.js';
import {createApp} from '../server/index.js';
const fixed='2026-11-13T16:00:00Z';
const setup=()=>createStore(':memory:',{now:()=>new Date(fixed)});
const order=(s,p,q=1,date=s.today())=>s.createOrder({date,type:'reservation',lines:[{kind:'product',productId:p,quantity:q}]});
const menu=(s,date)=>s.saveMenu({date,published:true,combo_price:25,items:[{name:'Sopa',kind:'soup',stock:50,price:10}]});

test('50 beverages carry over days, receive 24, reserve and cancel without double deductions',()=>{
 let now=new Date(fixed);const s=createStore(':memory:',{now:()=>now});
 try{
  const id=s.saveProduct({name:'Agua mineral',price:5,stock:50,minimum:10});
  const sale=order(s,id,8);s.transaction(()=>s.pay(sale.id,'qr'));assert.equal(s.inventory().products.find(p=>p.id===id).stock,42);
  const tomorrow='2026-11-14';menu(s,tomorrow);now=new Date('2026-11-14T16:00:00Z');
  assert.equal(s.menu(tomorrow).items.find(i=>i.productId===id).available,42);
  s.movement({productId:id,type:'receipt',quantity:24,date:tomorrow,supplier:'Proveedor',cost:80,note:'Entrega semanal'},'admin');
  assert.equal(s.inventory().products.find(p=>p.id===id).stock,66);
  const reserve=order(s,id,60);assert.equal(s.inventory().products.find(p=>p.id===id).stock,6);
  s.transition(reserve.id,'queued','cashier');assert.equal(s.inventory().products.find(p=>p.id===id).stock,6);
  s.transition(reserve.id,'cancelled','cashier');assert.equal(s.inventory().products.find(p=>p.id===id).stock,66);
  assert.throws(()=>s.transition(reserve.id,'cancelled','cashier'));assert.equal(s.inventory().products.find(p=>p.id===id).stock,66);
  assert.equal(s.inventory().movements.filter(m=>m.product_id===id&&m.type==='receipt')[0].supplier,'Proveedor');
 }finally{s.db.close();}
});

test('mixed orders roll back stock and ledger on shortages or failed payments; prices remain historical',()=>{
 const s=setup();try{
  const id=s.saveProduct({name:'Agua',price:5,stock:2,minimum:1}),soup=s.menu(s.today()).items.find(i=>i.kind==='soup');
  const before=s.inventory();assert.throws(()=>s.createOrder({date:s.today(),type:'reservation',lines:[{itemId:soup.id,quantity:1},{kind:'product',productId:id,quantity:2},{kind:'product',productId:id,quantity:1}]}),/No alcanza/);
  assert.deepEqual(s.inventory(),before);assert.equal(s.get('SELECT used FROM items WHERE id=?',soup.id).used,0);
  assert.throws(()=>s.createOrder({date:s.today(),type:'reservation',payment:'invalid',lines:[{kind:'product',productId:id,quantity:1}]}));assert.deepEqual(s.inventory(),before);
  const sale=order(s,id);s.saveProduct({id,name:'Agua nueva',price:8,minimum:5,active:false});assert.equal(s.orders(s.today()).find(o=>o.id===sale.id).total,500);
  assert.throws(()=>order(s,id),/no disponible/);assert.ok(!s.menu(s.today()).items.some(i=>i.productId===id));
 }finally{s.db.close();}
});

test('receipts and adjustments validate stock and atomically record an optional cash expense',()=>{
 const s=setup();try{
  const id=s.saveProduct({name:'Agua',price:5,stock:2,minimum:1});
  s.movement({productId:id,type:'receipt',quantity:10,date:s.today(),cost:25,expense:true,method:'qr'},'admin');
  const r=s.report(s.today(),s.today());assert.equal(r.spent,2500);const movement=s.inventory().movements[0];assert.ok(movement.expense_id);assert.equal(movement.actor,'admin');
  s.movement({productId:id,type:'adjustment',quantity:-2,date:s.today(),note:'Dos botellas rotas'});assert.equal(s.inventory().products.find(p=>p.id===id).stock,10);
  const before=s.inventory();
  for(const body of [{quantity:-11,note:'Pérdida'},{quantity:0,note:'x'},{quantity:1},{quantity:1.5,note:'x'}])assert.throws(()=>s.movement({productId:id,type:'adjustment',date:s.today(),...body}));
  assert.deepEqual(s.inventory(),before);
  s.run('UPDATE cash_days SET closed_at=? WHERE date=?',fixed,s.today());
  assert.throws(()=>s.movement({productId:id,type:'receipt',quantity:1,date:s.today(),cost:5,expense:true,method:'cash'}),/cerrada/);assert.deepEqual(s.inventory(),before);
  s.movement({productId:id,type:'receipt',quantity:1,date:s.today(),cost:5});assert.equal(s.report(s.today(),s.today()).spent,2500);
  assert.throws(()=>s.movement({productId:id,type:'receipt',quantity:1,date:'2026-11-14'}),/recibas/);
 }finally{s.db.close();}
});

test('migration selects last daily balance without summing, preserves legacy orders and survives restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'foodsys-inventory-')),path=join(dir,'old.sqlite');let s;
 try{
  s=createStore(path,{seed:false,now:()=>new Date(fixed)});
  s.run("DELETE FROM migrations WHERE name='shared-beverages'");
  for(const [date,stock,used] of [['2026-11-12',50,8],['2026-11-13',42,2]]){
   s.run('INSERT INTO days VALUES (?,2500,1)',date);s.run("INSERT INTO items(date,name,kind,price,stock,used) VALUES (?,'Coca-Cola','drink',700,?,?)",date,stock,used);
  }
  const legacy=s.get("SELECT * FROM items WHERE date='2026-11-13'");
  const id=Number(s.run("INSERT INTO orders(date,customer,type,source,status,total,created_at) VALUES (?,'Ana','reservation','staff','reserved',700,?)",s.today(),fixed).lastInsertRowid);
  s.run('INSERT INTO allocations VALUES (?,?,1)',id,legacy.id);s.run('INSERT INTO lines(order_id,label,quantity,price) VALUES (?,?,1,700)',id,'Coca-Cola');
  const orders=s.orders(s.today());s.db.close();s=createStore(path,{now:()=>new Date(fixed)});
  const p=s.inventory().products[0];assert.equal(p.stock,40);assert.equal(s.inventory().products.length,1);assert.deepEqual(s.orders(s.today()),orders);assert.deepEqual(s.get('SELECT * FROM items WHERE id=?',legacy.id),legacy);
  menu(s,'2026-11-14');assert.equal(s.menu('2026-11-14').items.find(i=>i.productId===p.id).available,40);
  s.transition(id,'cancelled','cashier');assert.equal(s.inventory().products[0].stock,41);
  s.db.close();s=createStore(path,{now:()=>new Date(fixed)});assert.equal(s.inventory().products[0].stock,41);assert.equal(s.inventory().movements.filter(m=>m.type==='migration').length,1);
 }finally{s?.db.close();rmSync(dir,{force:true,recursive:true});}
});

test('HTTP inventory permissions, shared public stock and concurrent reservations',async()=>{
 const s=setup(),app=createApp(s),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}/api`;
 async function request(path,body,cookie){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 try{
  assert.equal((await request('/inventory')).status,401);
  const admin=await request('/login',{username:'admin',password:'admin123'}),cashier=await request('/login',{username:'cajero',password:'cajero123'});
  assert.equal((await request('/inventory',undefined,cashier.cookie)).status,403);assert.equal((await request('/inventory/products',{name:'x'},cashier.cookie)).status,403);
  const created=await request('/inventory/products',{name:'Agua',price:5,stock:1,minimum:5},admin.cookie);assert.equal(created.status,200);
  const id=created.data.id;const body={date:s.today(),customer:'Ana',phone:'70000000',lines:[{kind:'product',productId:id,quantity:1}]};
  const results=await Promise.all([request('/public/reservations',body),request('/public/reservations',body)]);assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
  assert.equal((await request('/public/menu')).data.menu.items.find(i=>i.productId===id).available,0);
  assert.equal((await request('/inventory/movements',{productId:id,type:'receipt',quantity:24,date:s.today(),supplier:'Distribuidora',cost:60},admin.cookie)).status,200);
  assert.equal((await request('/inventory',undefined,admin.cookie)).data.products.find(p=>p.id===id).stock,24);
  assert.equal((await request('/inventory/movements',{productId:id,type:'receipt',quantity:24,date:s.today()},cashier.cookie)).status,403);
 }finally{app.locals.stop();await new Promise(r=>server.close(r));s.db.close();}
});

test('optional beverage photos persist, can be omitted or removed, and do not change stock or sales',()=>{
 const dir=mkdtempSync(join(tmpdir(),'foodsys-beverage-photo-')),path=join(dir,'photos.sqlite');let s;
 const photo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
 try{
  s=createStore(path,{now:()=>new Date(fixed)});
  const id=s.saveProduct({name:'Agua sin foto',price:5,stock:50,minimum:5});assert.equal(s.inventory().products.find(p=>p.id===id).photo,'');
  const withPhoto=s.saveProduct({name:'Agua con foto',price:7,stock:10,minimum:2,photo});assert.equal(s.menu(s.today()).items.find(p=>p.productId===withPhoto).photo,photo);
  order(s,id,8);const orders=s.orders(s.today()),movements=s.inventory().movements;
  s.saveProduct({id,name:'Agua sin foto',price:5,minimum:5,photo});
  s.saveProduct({id,name:'Agua sin foto',price:5,minimum:5});assert.equal(s.inventory().products.find(p=>p.id===id).photo,photo);
  for(const bad of ['https://example.com/foto.png','data:image/svg+xml;base64,AAAA','data:image/png;base64,%%%%',null,42,'data:image/png;base64,'+'A'.repeat(200000)]){
   assert.throws(()=>s.saveProduct({id,name:'No guardar',price:1,minimum:0,photo:bad}),/Foto inválida/);
  }
  const p=s.inventory().products.find(p=>p.id===id);assert.equal(p.name,'Agua sin foto');assert.equal(p.stock,42);assert.equal(p.price,500);
  assert.deepEqual(s.orders(s.today()),orders);assert.deepEqual(s.inventory().movements,movements);
  s.db.close();s=createStore(path,{now:()=>new Date(fixed)});assert.equal(s.menu(s.today()).items.find(p=>p.productId===id).photo,photo);
  s.saveProduct({id,name:'Agua sin foto',price:5,minimum:5,photo:''});assert.equal(s.menu(s.today()).items.find(p=>p.productId===id).photo,'');assert.equal(s.inventory().products.find(p=>p.id===id).stock,42);
 }finally{s?.db.close();rmSync(dir,{force:true,recursive:true});}
});

test('HTTP beverage photo payloads above 100 KB are accepted only for admin and reach the catalog',async()=>{
 const s=setup(),app=createApp(s),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}/api`;
 async function post(path,body,cookie){const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 try{
  const admin=await post('/login',{username:'admin',password:'admin123'}),cashier=await post('/login',{username:'cajero',password:'cajero123'});
  const photo='data:image/jpeg;base64,'+'A'.repeat(120000),body={name:'Foto grande',price:5,stock:50,minimum:5,photo};
  assert.equal((await post('/inventory/products',body,cashier.cookie)).status,403);
  const result=await post('/inventory/products',body,admin.cookie);assert.equal(result.status,200);
  const menu=await (await fetch(base+'/public/menu')).json();assert.equal(menu.menu.items.find(p=>p.productId===result.data.id).photo,photo);
  const removed=await post('/inventory/products',{...body,id:result.data.id,photo:''},admin.cookie);assert.equal(removed.status,200);assert.equal(s.inventory().products.find(p=>p.id===result.data.id).photo,'');
 }finally{app.locals.stop();await new Promise(r=>server.close(r));s.db.close();}
});
