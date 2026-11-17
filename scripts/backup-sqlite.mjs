import {DatabaseSync,backup} from 'node:sqlite';
import {mkdir,open,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const source=resolve(process.env.DB_PATH||'data/foodsys.sqlite'),destination=resolve(process.argv[2]||'backups/foodsys-'+new Date().toISOString().replaceAll(':','-')+'.sqlite');
let db,created=false;
try{
 if(!existsSync(source))throw new Error('No existe la base SQLite de origen.');
 if(source===destination)throw new Error('El respaldo debe tener una ruta distinta al origen.');
 await mkdir(dirname(destination),{recursive:true});const file=await open(destination,'wx',0o600);await file.close();created=true;
 db=new DatabaseSync(source,{readOnly:true});await backup(db,destination);db.close();db=null;
 const check=new DatabaseSync(destination,{readOnly:true});try{if(check.prepare('PRAGMA quick_check').all().some(r=>r.quick_check!=='ok'))throw new Error('El respaldo no pasó la verificación.');}finally{check.close();}
 console.log('Respaldo SQLite consistente creado:',destination);
}catch(error){if(created)await rm(destination,{force:true});console.error('No se creó el respaldo:',error.message);process.exitCode=1;}finally{db?.close();}
