import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore,checkPassword} from '../server/store.js';
import {createApp} from '../server/index.js';
const fixed='2026-11-13T16:00:00Z';
async function fixture(run){let clock=new Date(fixed);const s=createStore(':memory:',{now:()=>clock}),app=createApp(s),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}/api`;
 async function request(path,body,cookie){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const login=(username,password)=>request('/login',{username,password});
 try{await run({s,request,login,setClock:value=>clock=new Date(value)});}finally{app.locals.stop();await new Promise(r=>server.close(r));s.db.close();}
}

test('cashier records opening and closing with verified identity; kitchen and public cannot, reports remain restricted',()=>fixture(async({s,request,login})=>{
 const cashier=await login('cajero','cajero123'),kitchen=await login('cocina','cocina123'),admin=await login('admin','admin123');
 assert.equal((await request('/cash')).status,401);assert.equal((await request('/cash',undefined,kitchen.cookie)).status,403);
 for(const path of ['/cash/opening','/cash/close'])assert.equal((await request(path,{amount:10,counted:10},kitchen.cookie)).status,403);
 assert.equal((await request('/cash/opening',{amount:100,actor:{username:'admin'}},cashier.cookie)).status,200);
 const item=s.menu(s.today()).items.find(i=>i.kind==='soup');s.createOrder({date:s.today(),type:'sale',payment:'cash',lines:[{itemId:item.id,quantity:1}]});
 assert.equal((await request('/cash/opening',{amount:200},cashier.cookie)).status,400);
 assert.equal((await request('/cash/close',{counted:108,note:'Diferencia de dos bolivianos',actor:{username:'admin'}},cashier.cookie)).status,200);
 const cash=await request('/cash?date=2020-01-01',undefined,cashier.cookie);assert.equal(cash.data.cash.date,s.today());assert.equal(cash.data.history,undefined);
 const event=cash.data.events.find(e=>e.action==='cash_closed');assert.equal(event.actor_username,'cajero');assert.equal(event.details.expected,11000);assert.equal(event.details.difference,-200);assert.equal(event.created_at,new Date(fixed).toISOString());
 assert.equal((await request('/cash/close',{counted:999},cashier.cookie)).status,400);assert.equal(s.get('SELECT counted FROM cash_days WHERE date=?',s.today()).counted,10800);
 assert.equal((await request('/orders',{date:s.today(),type:'sale',lines:[{itemId:item.id,quantity:1}]},cashier.cookie)).status,409);
 assert.equal((await request('/reports?from='+s.today()+'&to='+s.today(),undefined,cashier.cookie)).status,403);
 assert.equal((await request('/expenses',{description:'x',amount:1,method:'cash'},cashier.cookie)).status,403);
 assert.equal((await request('/cash',undefined,admin.cookie)).data.history[0].events.find(e=>e.action==='cash_closed').actor_username,'cajero');
}));

test('automatic closure is recorded once as system; later cashier count remains separate and blocked operations stay blocked',()=>fixture(async({s,request,login,setClock})=>{
 const cashier=await login('cajero','cajero123');setClock('2026-11-13T22:00:00Z');
 const auto=await request('/cash',undefined,cashier.cookie);assert.equal(auto.data.cash.counted,null);assert.equal(auto.data.events.filter(e=>e.action==='cash_auto_closed').length,1);
 s.reconcile();assert.equal(s.cashEvents(s.today()).filter(e=>e.action==='cash_auto_closed').length,1);
 const closedAt=auto.data.cash.closed_at;setClock('2026-11-13T22:10:00Z');
 assert.equal((await request('/cash/close',{counted:0,note:'Conteo después del cierre automático'},cashier.cookie)).status,200);
 const counted=s.cashEvents(s.today()).find(e=>e.action==='cash_counted');assert.equal(counted.actor_username,'cajero');assert.equal(s.get('SELECT closed_at FROM cash_days WHERE date=?',s.today()).closed_at,closedAt);
}));

test('only admin manages users; no credential hashes returned; edits revoke sessions and disabled accounts cannot login',()=>fixture(async({s,request,login})=>{
 const admin=await login('admin','admin123'),cashier=await login('cajero','cajero123'),kitchen=await login('cocina','cocina123');
 for(const cookie of [cashier.cookie,kitchen.cookie]){assert.equal((await request('/users',undefined,cookie)).status,403);assert.equal((await request('/users',{name:'Hacker'},cookie)).status,403);}
 const body={name:'Ana Caja',username:'ana',role:'cashier',password:'Prueba123!',active:true};
 const created=await request('/users',body,admin.cookie);assert.equal(created.status,200);const id=created.data.id;
 const list=await request('/users',undefined,admin.cookie);assert.ok(!JSON.stringify(list.data).includes('Prueba123!'));for(const u of list.data.users){assert.equal(u.password,undefined);assert.equal(u.active,1);}
 const ana=await login('ana','Prueba123!');assert.equal(ana.status,200);assert.ok(ana.cookie);
 assert.equal((await request('/users',{...body,id,role:'kitchen',password:''},admin.cookie)).status,200);
 assert.equal((await request('/me',undefined,ana.cookie)).status,401);const anaKitchen=await login('ana','Prueba123!');assert.equal(anaKitchen.data.role,'kitchen');assert.equal((await request('/cash',undefined,anaKitchen.cookie)).status,403);
 assert.equal((await request('/users',{...body,id,role:'kitchen',password:'Nueva123!'},admin.cookie)).status,200);assert.equal((await request('/me',undefined,anaKitchen.cookie)).status,401);assert.equal((await login('ana','Prueba123!')).status,401);
 const changed=await login('ana','Nueva123!');assert.equal(changed.status,200);
 assert.equal((await request('/users',{...body,id,password:'',active:false},admin.cookie)).status,200);assert.equal((await login('ana','Nueva123!')).status,401);assert.equal((await request('/me',undefined,changed.cookie)).status,401);
 assert.equal((await request('/users',{...body,id,password:'',active:true},admin.cookie)).status,200);assert.equal((await login('ana','Nueva123!')).status,200);
 assert.equal((await request('/users',body,admin.cookie)).status,400);assert.equal(s.users().filter(u=>u.username==='ana').length,1);
 const log=s.userAudit();assert.ok(log.some(e=>e.details.password_changed));assert.ok(log.every(e=>e.actor_username==='admin'));assert.ok(!JSON.stringify(log).includes('Nueva123!'));
}));

test('admin self protection, role and password validation, and last administrator protection',()=>fixture(async({s,request,login})=>{
 const loginResult=await login('admin','admin123'),admin=s.users().find(u=>u.username==='admin'),body={id:admin.id,name:admin.name,username:'admin',role:'admin',active:true,password:''};
 for(const update of [{active:false},{role:'cashier'},{role:'owner'},{password:'short'},{password:12345678},{username:'bad name'},{active:'false'}])assert.equal((await request('/users',{...body,...update},loginResult.cookie)).status,400);
 assert.equal((await login('admin','admin123')).status,200);assert.equal(s.get('SELECT COUNT(*) AS n FROM users WHERE active=1 AND role=?','admin').n,1);
 // Defensive invariant also holds if an administrator attempts to remove the sole remaining administrator.
 const cashier=s.users().find(u=>u.role==='cashier');assert.throws(()=>s.saveUser({...body,active:false},cashier),/al menos un administrador/);
 const updated=await request('/users',{...body,password:'AdminNueva123!'},loginResult.cookie);assert.equal(updated.data.reauthenticate,true);assert.equal((await request('/me',undefined,loginResult.cookie)).status,401);
}));

test('migration preserves existing users, sessions, orders and cash; renamed seeded users are not recreated at restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'foodsys-control-')),path=join(dir,'legacy.sqlite');let s;
 try{
  s=createStore(path,{now:()=>new Date(fixed)});const admin=s.users().find(u=>u.username==='admin');
  const soup=s.menu(s.today()).items.find(i=>i.kind==='soup');s.createOrder({date:s.today(),type:'sale',payment:'cash',lines:[{itemId:soup.id,quantity:1}]});
  s.run('INSERT INTO sessions VALUES (?,?,?)','legacy-token',admin.id,Date.now()+60000);s.run('UPDATE cash_days SET opening=10000,counted=11000,closed_at=? WHERE date=?',fixed,s.today());
  s.run('DELETE FROM audit_log');s.db.exec('DROP TABLE audit_log; ALTER TABLE users DROP COLUMN active');
  const users=s.all('SELECT * FROM users'),orders=s.orders(s.today()),cash=s.get('SELECT * FROM cash_days WHERE date=?',s.today());s.db.close();
  s=createStore(path,{now:()=>new Date(fixed)});assert.equal(s.users().length,users.length);assert.deepEqual(s.orders(s.today()),orders);assert.deepEqual(s.get('SELECT * FROM cash_days WHERE date=?',s.today()),cash);assert.equal(s.cashEvents(s.today()).length,0);
  assert.ok(s.get('SELECT token FROM sessions WHERE token=?','legacy-token'));assert.ok(checkPassword('admin123',s.get('SELECT password FROM users WHERE id=?',admin.id).password));
  s.saveUser({...admin,username:'maria',active:true,password:''},admin);s.db.close();s=createStore(path,{now:()=>new Date(fixed)});assert.equal(s.get("SELECT id FROM users WHERE username='admin'"),undefined);assert.equal(s.get("SELECT username FROM users WHERE id=?",admin.id).username,'maria');assert.equal(s.userAudit()[0].actor_username,'admin');
 }finally{s?.db.close();rmSync(dir,{recursive:true,force:true});}
});
