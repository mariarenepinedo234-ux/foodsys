import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createStore,checkPassword} from '../server/store.js';
import {postgresConfig} from '../server/database.js';
import {createApp} from '../server/index.js';
import {migrateSQLite,importTables} from '../scripts/migrate-sqlite.mjs';
const fixed='2026-11-13T16:00:00.000Z',now=()=>new Date(fixed),enabled=Boolean(process.env.POSTGRES_TEST_URL);
const photo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
async function schemaFixture(fn){
 const url=new URL(process.env.POSTGRES_TEST_URL);if(!url.pathname.endsWith('_test'))throw new Error('Utiliza una base dedicada terminada en _test.');
 const admin=new pg.Client(postgresConfig(url.toString())),schema='migration_test_'+randomUUID().replaceAll('-','');await admin.connect();
 try{await admin.query(`CREATE SCHEMA "${schema}"`);url.searchParams.set('options',`-c search_path=${schema}`);await fn(url.toString());}finally{try{await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{await admin.end();}}
}
async function seedSource(path){
 const s=await createStore(path,{now}),admin=(await s.users()).find(u=>u.role==='admin');
 await s.setOpening({amount:100},admin);const m=await s.menu(s.today());await s.saveMenu({date:s.today(),combo_price:25,published:true,items:[...m.items.filter(i=>!i.productId).map(i=>({...i,price:i.price/100})),{name:'Ensalada rusa',kind:'side',price:5,stock:20}]});
 const menu=await s.menu(s.today()),soup=menu.items.find(i=>i.kind==='soup'),main=menu.items.find(i=>i.kind==='main'),side=menu.items.find(i=>i.kind==='side'),drink=menu.items.find(i=>i.productId);
 await s.saveProduct({id:drink.productId,name:drink.name,price:7,minimum:5,photo});
 const combo={kind:'combo',soupId:soup.id,mainId:main.id,sideId:side.id,quantity:1};
 const paid=await s.createOrder({date:s.today(),customer:'Ana',phone:'70000000',type:'sale',payment:'cash',lines:[combo]});
 const pending=await s.createOrder({date:s.today(),customer:'Beatriz',phone:'70000001',lines:[combo,{kind:'product',productId:drink.productId,quantity:2}]},'public');
 await s.movement({productId:drink.productId,type:'receipt',quantity:24,date:s.today(),supplier:'Distribuidora',cost:60,expense:true,method:'qr'},'admin');
 await s.saveUser({name:'Caja de prueba',username:'caja_dos',role:'cashier',password:'Nueva123!',active:false},admin);
 await s.saveUser({...admin,username:'propietaria',password:'',active:true},admin);
 await s.run('INSERT INTO sessions VALUES (?,?,?)','source-session',admin.id,Date.now()+60000);
 await s.closeCash({counted:124.5,note:'Conteo de prueba'},admin);
 return {s,combo,paid,pending,drink};
}
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');

test('SQLite → PostgreSQL verifies every imported row, preserves credentials/photos/cash, survives restart and continues IDs',{skip:!enabled},()=>schemaFixture(async databaseUrl=>{
 const dir=mkdtempSync(join(tmpdir(),'foodsys-import-test-')),path=join(dir,'source.sqlite'),backup=join(dir,'backup.sqlite');let source,target;
 try{
  const seeded=await seedSource(path);source=seeded.s;const passwords=await source.all('SELECT id,password FROM users');await source.db.close();source=null;const originalHash=hash(path);
  execFileSync(process.execPath,['scripts/backup-sqlite.mjs',backup],{cwd:process.cwd(),env:{...process.env,DB_PATH:path},stdio:'pipe'});
  const plan=await migrateSQLite({sqlitePath:backup,dryRun:true});assert.equal(plan.counts.orders,2);assert.equal(plan.counts.users,4);
  const result=await migrateSQLite({sqlitePath:backup,databaseUrl});assert.equal(result.verified,true);assert.equal(hash(path),originalHash);assert.equal(result.counts.orders,2);
  target=await createStore(undefined,{databaseUrl,now});
  assert.equal(target.db.dialect,'postgres');assert.equal((await target.get('SELECT COUNT(*) AS n FROM sessions')).n,0);
  assert.deepEqual(await target.all('SELECT id,password FROM users ORDER BY id'),passwords.map(row=>({...row})));assert.ok(checkPassword('admin123',(await target.get("SELECT password FROM users WHERE username='propietaria'")).password));
  assert.equal((await target.inventory()).products[0].photo,photo);assert.equal((await target.get('SELECT counted FROM cash_days WHERE date=?',target.today())).counted,12450);
  assert.equal((await target.get('SELECT stock FROM products WHERE id=?',seeded.drink.productId)).stock,42);assert.equal((await target.orders(target.today())).length,2);
  await assert.rejects(()=>migrateSQLite({sqlitePath:backup,databaseUrl}),/ya tiene datos/);assert.equal((await target.orders(target.today())).length,2);
  const id=await target.saveProduct({name:'Agua',price:5,stock:10,minimum:2});assert.ok(id>seeded.drink.productId);
  const order=await target.createOrder({date:target.today(),customer:'Continuación',type:'reservation',lines:[seeded.combo]});assert.ok(order.id>seeded.pending.id);
  const before=await target.inventory();await target.db.close();target=await createStore(undefined,{databaseUrl,now});assert.equal((await target.orders(target.today())).length,3);assert.deepEqual(await target.inventory(),before);
  const app=createApp(target),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try{
   const base=`http://127.0.0.1:${server.address().port}/api`;assert.deepEqual(await(await fetch(base+'/health')).json(),{status:'ok',database:'postgres'});
   const login=await fetch(base+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'propietaria',password:'admin123'})});assert.equal(login.status,200);await login.json();
  }finally{app.locals.stop();await new Promise(r=>server.close(r));}
 }finally{await source?.db.close();await target?.db.close();rmSync(dir,{recursive:true,force:true});}
}));

test('failed import rolls back all application tables; retry into the empty destination succeeds',{skip:!enabled},()=>schemaFixture(async databaseUrl=>{
 const dir=mkdtempSync(join(tmpdir(),'foodsys-import-rollback-')),path=join(dir,'source.sqlite');let source,target;
 try{
  source=await createStore(path,{now});await source.db.close();source=null;
  target=await createStore(undefined,{databaseUrl,seed:false,initialize:false,now});await target.db.exec("ALTER TABLE users ADD CONSTRAINT test_reject_cashier CHECK(username<>'cajero')");
  await assert.rejects(()=>migrateSQLite({sqlitePath:path,databaseUrl}),/PostgreSQL/);
  for(const table of importTables)assert.equal((await target.get(`SELECT COUNT(*) AS n FROM ${table}`)).n,0,table);
  await target.db.exec('ALTER TABLE users DROP CONSTRAINT test_reject_cashier');assert.equal((await migrateSQLite({sqlitePath:path,databaseUrl})).verified,true);
 }finally{await source?.db.close();await target?.db.close();rmSync(dir,{recursive:true,force:true});}
}));

test('two independent PostgreSQL connections cannot oversell the last unit or overwrite a concurrent edit',{skip:!enabled},()=>schemaFixture(async databaseUrl=>{
 let a,b;try{
  [a,b]=await Promise.all([createStore(undefined,{databaseUrl,now}),createStore(undefined,{databaseUrl,now})]);
  const id=await a.saveProduct({name:'Última bebida',price:7,stock:1,minimum:5});const body={date:a.today(),customer:'Ana',type:'reservation',lines:[{kind:'product',productId:id,quantity:1}]};
  const results=await Promise.allSettled([a.createOrder(body),b.createOrder(body)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected')[0].reason.status,409);assert.equal((await b.get('SELECT stock FROM products WHERE id=?',id)).stock,0);
  const order=results.find(r=>r.status==='fulfilled').value,actor=(await a.users()).find(u=>u.role==='cashier'),data=await a.orderForEdit(order.id),edit={version:0,lines:data.order.lines.map(l=>({...l.choice,lineId:l.id,quantity:l.quantity}))};
  const edits=await Promise.allSettled([a.editOrder(order.id,edit,actor),b.editOrder(order.id,edit,actor)]);assert.equal(edits.filter(r=>r.status==='fulfilled').length,1);assert.equal(edits.filter(r=>r.status==='rejected')[0].reason.status,409);assert.equal((await a.get('SELECT stock FROM products WHERE id=?',id)).stock,0);
 }finally{await a?.db.close();await b?.db.close();}
}));
