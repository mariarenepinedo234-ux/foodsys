import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {spawn} from 'node:child_process';
let settings;
try{settings=parseEnv(readFileSync('.env','utf8'));}catch{console.error('Copia .env.example a .env antes de iniciar las pruebas locales.');process.exit(1);}
let url;try{url=new URL(settings.DATABASE_URL);}catch{console.error('Configura una DATABASE_URL local válida en .env.');process.exit(1);}
if(!['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)){
 console.error('Los comandos :local solo admiten PostgreSQL en tu computadora. No uses la conexión de Render para estas pruebas.');process.exit(1);
}
// Explicit .env values take precedence, including over a production URL inherited from the terminal.
const child=spawn(process.execPath,[...(process.argv.includes('--watch')?['--watch']:[]),'server/index.js'],{stdio:'inherit',env:{...process.env,...settings,DB_DRIVER:'postgres'}});
process.once('SIGINT',()=>child.kill('SIGINT'));process.once('SIGTERM',()=>child.kill('SIGTERM'));
child.once('error',()=>{console.error('No se pudo iniciar el servidor local.');process.exitCode=1;});child.once('exit',code=>{process.exitCode=code??0;});
