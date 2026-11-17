import {createStore as baseCreateStore} from '../../server/store.js';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {postgresConfig} from '../../server/database.js';
export * from '../../server/store.js';
// Every PostgreSQL fixture has its own schema. File fixtures stay SQLite to exercise upgrades and imports.
export async function createStore(filename,options={}){
 const testUrl=process.env.POSTGRES_TEST_URL;
 if(filename!==':memory:'||!testUrl)return baseCreateStore(filename,options);
 const parsed=new URL(testUrl);if(!parsed.pathname.endsWith('_test'))throw new Error('POSTGRES_TEST_URL debe apuntar a una base con nombre terminado en _test.');
 const schema='test_'+randomUUID().replaceAll('-',''),admin=new pg.Client(postgresConfig(testUrl));await admin.connect();
 await admin.query(`CREATE SCHEMA "${schema}"`);parsed.searchParams.set('options',`-c search_path=${schema}`);
 try{
  const store=await baseCreateStore(undefined,{...options,databaseUrl:parsed.toString()});const close=store.db.close;
  store.db.close=async()=>{try{await close();}finally{await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}};return store;
 }catch(error){await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();throw error;}
}
