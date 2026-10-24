import pg from 'pg';
import {createRemoteStore} from './remote-store.mjs';

// The shared SQL store owns validation and order workflows. This adapter maps its
// fixed SQL statements to PostgreSQL and pins each transaction to one connection.
export function postgresSql(sql){
  let index=0;
  sql=sql.replace(/\?/g,()=>'$'+(++index))
    .replace('id TEXT PRIMARY KEY, category','position BIGSERIAL UNIQUE, id TEXT PRIMARY KEY, category')
    .replace('history (id INTEGER PRIMARY KEY,','history (id BIGSERIAL PRIMARY KEY,')
    .replace('expires INTEGER','expires BIGINT').replace('until INTEGER','until BIGINT')
    .replace('ORDER BY rowid','ORDER BY position')
    .replace('DO UPDATE SET count=count+1','DO UPDATE SET count=rate_limits.count+1');
  if(sql.startsWith('INSERT OR IGNORE INTO '))sql=sql.replace('INSERT OR IGNORE INTO ','INSERT INTO ')+' ON CONFLICT DO NOTHING';
  return sql;
}

export function createPostgresClient(pool){
  const execute=(connection,input)=>{
    const {sql,args=[]}=typeof input==='string'?{sql:input}:input;
    return connection.query(postgresSql(sql),args);
  };
  async function transaction(){
    const connection=await pool.connect();let released=false;
    try{
      await connection.query('BEGIN');
      // Serializes store mutations across serverless instances, preserving the
      // idempotency and status-version checks of the shared SQL implementation.
      await connection.query('SELECT pg_advisory_xact_lock(173561, 1)');
      return {execute:input=>execute(connection,input),commit:()=>connection.query('COMMIT'),rollback:()=>connection.query('ROLLBACK'),close(){if(!released){released=true;connection.release();}}};
    }catch(error){try{await connection.query('ROLLBACK');}catch{}connection.release();throw error;}
  }
  return {execute:input=>execute(pool,input),transaction,async batch(statements){
    const tx=await transaction();
    try{for(const statement of statements)await tx.execute(statement);await tx.commit();}
    catch(error){await tx.rollback();throw error;}finally{tx.close();}
  },close:()=>pool.end()};
}

export async function createPostgresStore(connectionString,seed){
  const url=new URL(connectionString);
  if(!['postgres:','postgresql:'].includes(url.protocol))throw Error('DATABASE_URL precisa ser uma conexão PostgreSQL.');
  const pool=new pg.Pool({connectionString,max:3,connectionTimeoutMillis:10000,idleTimeoutMillis:10000,allowExitOnIdle:true,statement_timeout:15000});
  pool.on('error',error=>console.error('Conexão PostgreSQL:',error.code||error.name));
  const client=createPostgresClient(pool);
  try{return await createRemoteStore(client,seed);}catch(error){await client.close();throw error;}
}
