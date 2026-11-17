import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../server/store.js';
import {createApp} from '../server/index.js';
const fixed='2026-11-13T16:00:00Z';
function setup(){const s=createStore(':memory:',{now:()=>new Date(fixed)});addSides(s);return s;}
function addSides(s){const m=s.menu(s.today());s.saveMenu({date:s.today(),combo_price:25,published:true,items:[...m.items.filter(i=>!i.productId).map(i=>({...i,price:i.price/100})),{name:'Ensalada rusa',kind:'side',price:5,stock:10},{name:'Ensalada fit',kind:'side',price:6,stock:8}]});}
const actor=s=>s.users().find(u=>u.role==='cashier');
function choices(s){const m=s.menu(s.today()),items=m.items;return {soup:items.find(i=>i.kind==='soup'),mains:items.filter(i=>i.kind==='main'),sides:items.filter(i=>i.kind==='side'),drink:items.find(i=>i.productId)};}
function combo(s,overrides={}){const c=choices(s);return {kind:'combo',soupId:c.soup.id,mainId:c.mains[0].id,sideId:c.sides[0]?.id,quantity:1,...overrides};}
const create=(s,lines,extra={})=>s.createOrder({date:s.today(),customer:'Ana',phone:'70000000',type:'reservation',lines,...extra});
const lineBody=l=>({...l.choice,lineId:l.id,quantity:l.quantity});
function snapshot(s){return Object.fromEntries(['orders','lines','allocations','product_allocations','items','products','payments','inventory_movements','audit_log'].map(t=>[t,s.all(`SELECT * FROM ${t}`)]));}

test('guarniciones have daily production, are chosen in complete and sold separately with one shared stock',()=>{
 const s=setup();try{
  const c=choices(s);const order=create(s,[combo(s,{quantity:2}),{kind:'item',itemId:c.sides[0].id,quantity:3}]);assert.equal(order.total,6500);
  assert.equal(s.get('SELECT used FROM items WHERE id=?',c.sides[0].id).used,5);assert.equal(s.get('SELECT used FROM items WHERE id=?',c.sides[1].id).used,0);
  const lines=s.orders(s.today())[0].lines;assert.match(lines[0].label,/Ensalada rusa/);assert.match(lines[0].label,/vaso de refresco incluido/);assert.equal(lines[1].price,500);
  s.transition(order.id,'cancelled','cashier');for(const i of [c.soup,c.mains[0],...c.sides])assert.equal(s.get('SELECT used FROM items WHERE id=?',i.id).used,0);
  assert.throws(()=>s.transition(order.id,'cancelled','cashier'));
 }finally{s.db.close();}
});

test('complete requires a valid side when offered and insufficient sides roll back the entire order',()=>{
 const s=setup();try{
  const c=choices(s),before=snapshot(s);
  for(const line of [combo(s,{sideId:undefined}),combo(s,{sideId:c.mains[0].id}),combo(s,{quantity:11})])assert.throws(()=>create(s,[line]));assert.deepEqual(snapshot(s),before);
  s.run('UPDATE items SET stock=0 WHERE kind=?','side');assert.throws(()=>create(s,[combo(s)]),/No alcanza/);
 }finally{s.db.close();}
});

test('edit public reservation swaps main and side, adds dishes and beverages, preserves number and metadata, and releases on cancellation once',()=>{
 const s=setup();try{
  const c=choices(s),body={date:s.today(),customer:'Ana',phone:'70000000',lines:[combo(s),{kind:'product',productId:c.drink.productId,quantity:2}]};const order=s.createOrder(body,'public');
  const original=s.orders(s.today())[0],edit=s.orderForEdit(order.id);
  assert.equal(edit.menu.items.find(i=>i.id===c.sides[0].id).available,10);assert.equal(edit.menu.items.find(i=>i.productId===c.drink.productId).available,20);
  const result=s.editOrder(order.id,{version:edit.order.version,customer:'Ana María',note:'Para llevar',lines:[{...lineBody(edit.order.lines[0]),mainId:c.mains[1].id,sideId:c.sides[1].id},{kind:'item',itemId:c.mains[0].id,quantity:1},{kind:'item',itemId:c.sides[0].id,quantity:1},{kind:'product',productId:c.drink.productId,quantity:3}]},actor(s));
  assert.equal(result.id,order.id);assert.equal(result.total,6900);assert.equal(result.status,'reserved');assert.equal(result.version,1);
  const saved=s.orders(s.today())[0];assert.equal(saved.created_at,original.created_at);assert.equal(saved.source,'public');assert.equal(saved.phone,'70000000');assert.equal(saved.date,original.date);assert.equal(s.all('SELECT * FROM orders').length,1);assert.equal(s.all('SELECT * FROM payments').length,0);
  for(const id of [c.soup.id,...c.mains.map(i=>i.id),...c.sides.map(i=>i.id)])assert.equal(s.get('SELECT used FROM items WHERE id=?',id).used,1);
  assert.equal(s.get('SELECT stock FROM products WHERE id=?',c.drink.productId).stock,17);
  const audit=s.orderForEdit(order.id).history[0];assert.equal(audit.actor_username,'cajero');assert.equal(audit.details.before.total,3900);assert.equal(audit.details.after.total,6900);
  s.transition(order.id,'cancelled','cashier');assert.equal(s.get('SELECT stock FROM products WHERE id=?',c.drink.productId).stock,20);for(const i of s.menu(s.today()).items.filter(i=>!i.productId))assert.equal(i.used,0);
 }finally{s.db.close();}
});

test('failed edits and stale copies preserve old order, stock, inventory ledger and audit exactly',()=>{
 const s=setup();try{
  const c=choices(s),order=create(s,[combo(s),{kind:'product',productId:c.drink.productId,quantity:2}]),e=s.orderForEdit(order.id),before=snapshot(s);
  const bodies=[{lines:[combo(s,{sideId:c.sides[1].id,quantity:9})]},{lines:[]},{lines:[{kind:'product',productId:c.drink.productId,quantity:21}]},{lines:e.order.lines.map(lineBody),date:'2026-11-14'},{lines:e.order.lines.map(lineBody),expectedTotal:1},{lines:e.order.lines.map(lineBody),version:99},{lines:e.order.lines.map(lineBody),payment:'cash'}];
  for(const body of bodies){assert.throws(()=>s.editOrder(order.id,{version:0,...body},actor(s)));assert.deepEqual(snapshot(s),before);}
  s.editOrder(order.id,{version:0,lines:e.order.lines.map(lineBody)},actor(s));const after=snapshot(s);assert.throws(()=>s.editOrder(order.id,{version:0,lines:e.order.lines.map(lineBody)},actor(s)),/pedido cambió/);assert.deepEqual(snapshot(s),after);
 }finally{s.db.close();}
});

test('unchanged selections keep historical unit prices, substitutions and added dishes use current prices',()=>{
 const s=setup();try{
  const c=choices(s),o=create(s,[combo(s)]),e=s.orderForEdit(o.id),m=s.menu(s.today());
  s.saveMenu({date:s.today(),combo_price:30,published:true,items:m.items.filter(i=>!i.productId).map(i=>({...i,price:i.price/100+1}))});
  const unchanged=s.editOrder(o.id,{version:0,expectedTotal:5000,lines:[{...lineBody(e.order.lines[0]),quantity:2}]},actor(s));assert.equal(unchanged.total,5000);
  const changed=s.editOrder(o.id,{version:1,expectedTotal:3600,lines:[{...lineBody(s.orderForEdit(o.id).order.lines[0]),quantity:1,mainId:c.mains[1].id},{kind:'item',itemId:c.sides[0].id,quantity:1}]},actor(s));assert.equal(changed.total,3600);
  s.transaction(()=>s.pay(o.id,'cash'));const before=snapshot(s);assert.throws(()=>s.editOrder(o.id,{version:2,lines:[combo(s)]},actor(s)),/pagado/);assert.deepEqual(snapshot(s),before);
  s.transition(o.id,'queued','cashier');s.transition(o.id,'preparing','kitchen');assert.throws(()=>s.orderForEdit(o.id),/preparación/);
 }finally{s.db.close();}
});

test('editing queued unpaid order preserves status; kitchen progress, paid orders and past orders block editing',()=>{
 const s=setup();try{
  const o=create(s,[combo(s)]);s.transition(o.id,'queued','cashier');const edit=s.orderForEdit(o.id);const result=s.editOrder(o.id,{version:0,lines:edit.order.lines.map(lineBody)},actor(s));assert.equal(result.status,'queued');assert.equal(s.orders(s.today())[0].status,'queued');
  s.transition(o.id,'preparing','kitchen');assert.throws(()=>s.editOrder(o.id,{version:1,lines:[combo(s)]},actor(s)),/preparación/);
  const past=create(s,[combo(s)]);s.run("INSERT INTO days(date) VALUES ('2026-11-12')");s.run("UPDATE orders SET date='2026-11-12' WHERE id=?",past.id);assert.throws(()=>s.orderForEdit(past.id),/pasado/);
 }finally{s.db.close();}
});

test('legacy lines survive migration, can be reselected if ambiguous, and edits persist across restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'foodsys-edit-')),path=join(dir,'legacy.sqlite');let s;
 try{
  s=createStore(path,{now:()=>new Date(fixed)});addSides(s);const o=create(s,[combo(s)]),old=s.orders(s.today())[0];
  const legacyLines=s.all('SELECT id,order_id,label,quantity,price FROM lines');s.db.exec('ALTER TABLE lines DROP COLUMN selection;ALTER TABLE orders DROP COLUMN version');s.db.close();
  s=createStore(path,{now:()=>new Date(fixed)});assert.deepEqual(s.all('SELECT id,order_id,label,quantity,price FROM lines'),legacyLines);assert.equal(s.orders(s.today())[0].total,old.total);
  let e=s.orderForEdit(o.id);assert.equal(e.order.lines[0].choice.sideId,choices(s).sides[0].id);
  s.run("UPDATE lines SET label='Detalle histórico no reconocible' WHERE order_id=?",o.id);e=s.orderForEdit(o.id);assert.equal(e.order.lines[0].choice,null);
  s.editOrder(o.id,{version:0,lines:[combo(s,{mainId:choices(s).mains[1].id})]},actor(s));s.db.close();s=createStore(path,{now:()=>new Date(fixed)});assert.equal(s.orderForEdit(o.id).order.version,1);assert.equal(s.orderForEdit(o.id).history.length,1);assert.equal(s.orders(s.today())[0].id,o.id);
 }finally{s?.db.close();rmSync(dir,{force:true,recursive:true});}
});

async function httpFixture(fn){const s=setup(),app=createApp(s),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}/api`;
 const request=async(path,body,cookie)=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 try{await fn({s,request});}finally{app.locals.stop();await new Promise(r=>server.close(r));s.db.close();}}

test('HTTP public complete includes chosen side, staff edit permissions and conflicting editors are enforced',()=>httpFixture(async({s,request})=>{
 const cashier=await request('/login',{username:'cajero',password:'cajero123'}),kitchen=await request('/login',{username:'cocina',password:'cocina123'});
 const publicMenu=await request('/public/menu');assert.equal(publicMenu.data.menu.items.filter(i=>i.kind==='side').length,2);
 const booked=await request('/public/reservations',{date:s.today(),customer:'Ana',phone:'70000000',lines:[combo(s)]});assert.equal(booked.status,201);const url=`/orders/${booked.data.id}/edit`;
 assert.equal((await request(url)).status,401);assert.equal((await request(url,undefined,kitchen.cookie)).status,403);assert.equal((await request(url,{version:0,lines:[combo(s)]},kitchen.cookie)).status,403);
 const edit=await request(url,undefined,cashier.cookie);const body={version:edit.data.order.version,lines:[combo(s,{mainId:choices(s).mains[1].id})]};
 const results=await Promise.all([request(url,body,cashier.cookie),request(url,body,cashier.cookie)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(s.all('SELECT * FROM orders').length,1);
 assert.equal((await request(`/orders/${booked.data.id}/status`,{status:'queued'},cashier.cookie)).status,200);assert.equal((await request(`/orders/${booked.data.id}/status`,{status:'preparing'},kitchen.cookie)).status,200);assert.equal((await request(url,{...body,version:1},cashier.cookie)).status,409);
}));

test('an edit can reuse its own last side portion; shortages and closed-cash sale edits keep stock unchanged',()=>{
 const s=setup();try{
  const c=choices(s);s.run('UPDATE items SET stock=1 WHERE id=?',c.sides[0].id);
  const o=create(s,[combo(s)]),edit=s.orderForEdit(o.id);assert.equal(s.menu(s.today()).items.find(i=>i.id===c.sides[0].id).available,0);assert.equal(edit.menu.items.find(i=>i.id===c.sides[0].id).available,1);
  s.editOrder(o.id,{version:0,lines:edit.order.lines.map(lineBody)},actor(s));assert.equal(s.get('SELECT used FROM items WHERE id=?',c.sides[0].id).used,1);
  const before=snapshot(s);assert.throws(()=>s.editOrder(o.id,{version:1,lines:[combo(s,{quantity:2})]},actor(s)),/No alcanza/);assert.deepEqual(snapshot(s),before);
  const sale=create(s,[combo(s,{sideId:c.sides[1].id})],{type:'sale'});s.closeCash({counted:0},actor(s));const closed=snapshot(s);assert.throws(()=>s.editOrder(sale.id,{version:0,lines:s.orderForEdit(sale.id).order.lines.map(lineBody)},actor(s)),/cerrada/);assert.deepEqual(snapshot(s),closed);
  s.editOrder(o.id,{version:1,lines:[combo(s,{sideId:c.sides[1].id})]},actor(s));assert.equal(s.orders(s.today()).find(x=>x.id===o.id).status,'reserved');
 }finally{s.db.close();}
});
