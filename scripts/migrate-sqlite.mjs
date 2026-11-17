import {DatabaseSync,backup} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createStore} from '../server/store.js';
import {idTables} from '../server/database.js';

// Foreign-key order. Sessions are intentionally not migrated: users must sign in again.
export const importTables=['users','days','cash_days','items','orders','lines','allocations','payments','expenses','products','product_allocations','legacy_products','inventory_movements','migrations','audit_log'];
const fingerprint=(rows,columns)=>{const canonical=rows.map(row=>JSON.stringify(columns.map(c=>row[c]??null))).sort();const hash=createHash('sha256');for(const row of canonical)hash.update(row+'\n');return hash.digest('hex');};
export async function migrateSQLite({sqlitePath,databaseUrl=process.env.DATABASE_URL,dryRun=false}={}){
 if(!sqlitePath||!existsSync(sqlitePath))throw new Error('Indica una copia SQLite existente con --sqlite.');
 if(!dryRun&&!databaseUrl)throw new Error('Configura DATABASE_URL de PostgreSQL en el entorno; no la pases como argumento.');
 const dir=await mkdtemp(join(tmpdir(),'foodsys-migration-'));let raw,source,target;
 try{
  raw=new DatabaseSync(resolve(sqlitePath),{readOnly:true});
  const tables=raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t=>t.name);
  const allowed=new Set([...importTables,'sessions','app_schema_versions','app_data_imports']);
  if(tables.some(table=>!allowed.has(table)&&!table.startsWith('sqlite_')))throw new Error('La copia contiene tablas no reconocidas; requiere revisar la migración antes de continuar.');
  if(!['users','days','orders','items'].every(t=>tables.includes(t)))throw new Error('El archivo no es una base Foodsys reconocida.');
  const copy=join(dir,'source.sqlite');await backup(raw,copy);raw.close();raw=null;
  // Upgrade only our private copy, without demo data, reconciliation or business initialization.
  source=await createStore(copy,{seed:false,initialize:false});
  if((await source.all('PRAGMA quick_check')).some(r=>r.quick_check!=='ok')||(await source.all('PRAGMA foreign_key_check')).length)throw new Error('La copia SQLite tiene errores de integridad. Conserva el original y revisa el respaldo.');
  const content=new Map(),counts={};
  for(const table of importTables){const columns=(await source.db.columns(table)).map(c=>c.name),rows=await source.all(`SELECT ${columns.join(',')} FROM ${table}`);content.set(table,{columns,rows,hash:fingerprint(rows,columns)});counts[table]=rows.length;}
  if(!counts.users)throw new Error('La base de origen no contiene usuarios; no se importará como una instalación existente.');
  if(dryRun)return {mode:'dry-run',counts,sessions:'excluded'};
  target=await createStore(undefined,{databaseUrl,seed:false,initialize:false});
  if(target.db.dialect!=='postgres')throw new Error('El destino debe ser PostgreSQL.');
  await target.db.exec('CREATE TABLE IF NOT EXISTS app_data_imports(source_fingerprint TEXT PRIMARY KEY,completed_at TEXT NOT NULL)');
  await target.transaction(async()=>{
   for(const table of [...importTables,'sessions'])if((await target.get(`SELECT COUNT(*) AS count FROM ${table}`)).count)throw new Error(`El destino ya tiene datos (${table}). Se cancela sin sobrescribirlos; utiliza una base nueva vacía.`);
   for(const [table,{columns,rows,hash}] of content){
    const targetColumns=(await target.db.columns(table)).map(c=>c.name);if(columns.some(c=>!targetColumns.includes(c)))throw new Error(`Esquema incompatible en ${table}.`);
    for(let i=0;i<rows.length;i+=100){const batch=rows.slice(i,i+100);await target.run(`INSERT INTO ${table}(${columns.join(',')}) VALUES ${batch.map(()=>`(${columns.map(()=>'?').join(',')})`).join(',')}`,...batch.flatMap(row=>columns.map(c=>row[c]??null)));}
    const stored=await target.all(`SELECT ${columns.join(',')} FROM ${table}`);
    if(stored.length!==rows.length||fingerprint(stored,columns)!==hash)throw new Error(`Falló la verificación de datos en ${table}; se revierte toda la importación.`);
   }
   for(const table of idTables)await target.get(`SELECT setval(pg_get_serial_sequence(?, 'id'),GREATEST(COALESCE((SELECT MAX(id) FROM ${table}),1),1),EXISTS(SELECT 1 FROM ${table} WHERE id>=1))`,table);
   const sourceHash=createHash('sha256').update([...content.values()].map(t=>t.hash).join(':')).digest('hex');
   await target.run('INSERT INTO app_data_imports(source_fingerprint,completed_at) VALUES (?,?)',sourceHash,new Date().toISOString());
  });
  return {mode:'imported',counts,verified:true,sessions:'excluded'};
 }finally{raw?.close();await source?.db.close();await target?.db.close();await rm(dir,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const args=process.argv.slice(2),index=args.indexOf('--sqlite'),sqlitePath=index>=0?args[index+1]:undefined;const result=await migrateSQLite({sqlitePath,dryRun:args.includes('--dry-run')});console.log(JSON.stringify(result,null,2));}
 catch(error){console.error('Migración no completada:',error.message);process.exitCode=1;}
}
