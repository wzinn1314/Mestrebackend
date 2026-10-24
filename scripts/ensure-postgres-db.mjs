import pg from 'pg';
const url=new URL(process.env.DATABASE_URL);
if(url.hostname!=='127.0.0.1'||url.pathname!=='/mestredoslanches')throw Error('Este comando cria somente o banco local mestredoslanches.');
url.pathname='/postgres';
const client=new pg.Client({connectionString:url.href});await client.connect();
try{
  if(!(await client.query('SELECT 1 FROM pg_database WHERE datname=$1',['mestredoslanches'])).rowCount)await client.query('CREATE DATABASE mestredoslanches');
}finally{await client.end();}
