import {test} from 'node:test';
import assert from 'node:assert/strict';
import {postgresSQL,postgresConfig,createDatabase} from '../server/database.js';
import {createStore} from '../server/store.js';

test('PostgreSQL parameter translation preserves literal question marks and ON CONFLICT',()=>{
 assert.equal(postgresSQL("SELECT '?' AS question, 'it''s ?' AS note WHERE id=? AND name=?"),"SELECT '?' AS question, 'it''s ?' AS note WHERE id=$1 AND name=$2");
 assert.equal(postgresSQL('INSERT OR IGNORE INTO days(date) VALUES (?)'),'INSERT INTO days(date) VALUES ($1) ON CONFLICT DO NOTHING');
});
test('PostgreSQL requires verified TLS on remote connections and never logs malformed URLs',()=>{
 const before=process.env.PGSSLMODE;delete process.env.PGSSLMODE;
 try{
  assert.equal(postgresConfig('postgresql://test:password@database.example/test').ssl.rejectUnauthorized,true);
  const require=postgresConfig('postgresql://test:password@database.example/test?sslmode=require');assert.equal(require.ssl.rejectUnauthorized,true);assert.ok(!require.connectionString.includes('sslmode'));
  assert.equal(postgresConfig('postgresql://test:password@localhost/test').ssl,false);
  assert.throws(()=>postgresConfig('postgresql://test:password@database.example/test?sslmode=no-verify'));
  assert.throws(()=>postgresConfig('postgresql://test:password@database.example/test?ssl=false'));
  assert.throws(()=>postgresConfig('secret credential input'),error=>!error.message.includes('secret credential input'));
 }finally{if(before===undefined)delete process.env.PGSSLMODE;else process.env.PGSSLMODE=before;}
});
test('SQLite async transactions isolate concurrent callers and roll back a partially written transaction',async()=>{
 const db=await createDatabase({filename:':memory:'});try{
  await db.exec('CREATE TABLE counts(value INTEGER NOT NULL)');await db.run('INSERT INTO counts VALUES (1)');
  const results=await Promise.allSettled([db.transaction(async()=>{await db.run('UPDATE counts SET value=2');await new Promise(r=>setTimeout(r,5));throw new Error('rollback');}),db.get('SELECT value FROM counts')]);
  assert.equal(results[0].status,'rejected');assert.equal(results[1].value.value,1);
  await db.transaction(async()=>{await db.transaction(async()=>{await db.run('UPDATE counts SET value=3');});});assert.equal((await db.get('SELECT value FROM counts')).value,3);
 }finally{await db.close();}
});
test('explicit PostgreSQL mode with a missing connection fails instead of creating an ephemeral SQLite database',async()=>{
 const before={driver:process.env.DB_DRIVER,url:process.env.DATABASE_URL};process.env.DB_DRIVER='postgres';delete process.env.DATABASE_URL;
 try{await assert.rejects(()=>createStore(),/DATABASE_URL/);}finally{if(before.driver===undefined)delete process.env.DB_DRIVER;else process.env.DB_DRIVER=before.driver;if(before.url===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=before.url;}
});

test('a database from a newer schema version is refused without deleting existing data',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');const dir=mkdtempSync(join(tmpdir(),'foodsys-future-schema-')),path=join(dir,'future.sqlite');let s,db;
 try{
  s=await createStore(path);await s.run('INSERT INTO app_schema_versions VALUES (?,?)',2,new Date().toISOString());await s.db.close();s=null;
  await assert.rejects(()=>createStore(path),/más reciente/);db=await createDatabase({filename:path});assert.equal((await db.get('SELECT COUNT(*) AS count FROM users')).count,3);assert.equal((await db.get('SELECT MAX(version) AS version FROM app_schema_versions')).version,2);
 }finally{await s?.db.close();await db?.close();rmSync(dir,{recursive:true,force:true});}
});
