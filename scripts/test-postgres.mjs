import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
if(!process.env.POSTGRES_TEST_URL){console.error('Configura POSTGRES_TEST_URL para una base de pruebas dedicada cuyo nombre termine en _test.');process.exit(1);}
const files=readdirSync('test').filter(n=>n.endsWith('.test.js')).map(n=>'test/'+n);
const result=spawnSync(process.execPath,['--test',...files],{stdio:'inherit',env:process.env});process.exit(result.status??1);
