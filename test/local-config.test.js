import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const launcher=fileURLToPath(new URL('../scripts/local-server.mjs',import.meta.url));

test('local launcher requires explicit local configuration instead of inheriting a production connection',()=>{
 const dir=mkdtempSync(join(tmpdir(),'foodsys-no-local-env-'));
 try{const r=spawnSync(process.execPath,[launcher],{cwd:dir,env:{...process.env,DATABASE_URL:'postgresql://demo:DO_NOT_PRINT@production.invalid/db'},encoding:'utf8'});assert.equal(r.status,1);assert.match(r.stderr,/Copia .env.example/);assert.doesNotMatch(r.stderr,/DO_NOT_PRINT/);}finally{rmSync(dir,{recursive:true,force:true});}
});

test('local launcher rejects remote URLs without printing their password or starting the server',()=>{
 const dir=mkdtempSync(join(tmpdir(),'foodsys-remote-local-env-'));
 try{writeFileSync(join(dir,'.env'),'DATABASE_URL=postgresql://demo:DO_NOT_PRINT@production.invalid/db\n');const r=spawnSync(process.execPath,[launcher,'--watch'],{cwd:dir,encoding:'utf8'});assert.equal(r.status,1);assert.match(r.stderr,/solo admiten PostgreSQL en tu computadora/);assert.doesNotMatch(r.stderr,/DO_NOT_PRINT/);assert.doesNotMatch(r.stdout,/Foodsys API lista/);}finally{rmSync(dir,{recursive:true,force:true});}
});
