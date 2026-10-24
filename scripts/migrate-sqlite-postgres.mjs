import {DatabaseSync,backup} from 'node:sqlite';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {createPostgresStore} from '../lib/postgres-store.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
if(!process.env.DATABASE_URL)throw Error('Carregue .env.postgres.local ou configure DATABASE_URL.');
const source=new DatabaseSync(path.resolve(process.argv[2]||path.join(root,'data/loja.sqlite')),{readOnly:true});
const backupDir=path.join(root,'data','backups');await mkdir(backupDir,{recursive:true});
await backup(source,path.join(backupDir,`antes-postgres-${Date.now()}.sqlite`));
const tables=['products','settings','admin','sessions','orders','history'];
const records=Object.fromEntries(tables.map(table=>[table,source.prepare('SELECT * FROM '+table+(table==='products'?' ORDER BY rowid':'')).all()]));
source.close();
const seed=JSON.parse(await readFile(path.join(root,'config/loja.json'),'utf8'));
const store=await createPostgresStore(process.env.DATABASE_URL,seed);await store.close();
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
const client=await pool.connect();
try{
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(173561, 1)');
  const existing=await client.query('SELECT (SELECT count(*) FROM orders)+(SELECT count(*) FROM admin)+(SELECT count(*) FROM sessions) AS count');
  if(Number(existing.rows[0].count)!==0)throw Error('Destino já possui pedidos ou acesso: migração interrompida sem sobrescrever dados.');
  for(const table of ['history','orders','sessions','admin','products','settings'])await client.query('DELETE FROM '+table);
  for(const table of tables)for(const row of records[table]){
    const keys=Object.keys(row);
    await client.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_,index)=>'$'+(index+1)).join(',')})`,Object.values(row));
  }
  await client.query("SELECT setval(pg_get_serial_sequence('history','id'),COALESCE(MAX(id),1),MAX(id) IS NOT NULL) FROM history");
  for(const table of tables){const actual=Number((await client.query('SELECT count(*) AS count FROM '+table)).rows[0].count);if(actual!==records[table].length)throw Error('Contagem divergente em '+table);}
  await client.query('COMMIT');
  console.log(JSON.stringify({migrated:true,counts:Object.fromEntries(tables.map(table=>[table,records[table].length])),backupDirectory:backupDir}));
}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();await pool.end();}
