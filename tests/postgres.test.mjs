import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createPostgresStore,postgresSql} from '../lib/postgres-store.mjs';
import {createVercelHandler} from '../api/index.mjs';

test('PostgreSQL: placeholders, ordem e tipos compatíveis com o store SQL',()=>{
  assert.equal(postgresSql('INSERT OR IGNORE INTO settings VALUES(?,?)'),'INSERT INTO settings VALUES($1,$2) ON CONFLICT DO NOTHING');
  assert.equal(postgresSql('SELECT * FROM products ORDER BY rowid'),'SELECT * FROM products ORDER BY position');
  assert.match(postgresSql('CREATE TABLE history (id INTEGER PRIMARY KEY, order_id TEXT)'),/id BIGSERIAL PRIMARY KEY/);
});
test('Vercel: PostgreSQL exige DATABASE_URL sem exigir Firebase ou Turso',async()=>{
  let payload,status;const res={writeHead(value){status=value;},end(value){payload=JSON.parse(value);}};
  await createVercelHandler({env:{DATABASE_PROVIDER:'postgres',PUBLIC_ORIGIN:'https://cliente.example',MDL_ADMIN_PASSWORD:'82619304'}})({},res);
  assert.equal(status,503);assert.deepEqual(payload.missing,['DATABASE_URL']);
});
test('PostgreSQL real: transações entre instâncias, persistência, troco e versão',{skip:!process.env.TEST_POSTGRES_URL},async()=>{
  const connectionString=process.env.TEST_POSTGRES_URL,schema='mdl_test_'+randomUUID().replaceAll('-','');
  const control=new pg.Client({connectionString});await control.connect();
  await control.query('CREATE SCHEMA '+schema);
  const url=new URL(connectionString);url.searchParams.set('options','-c search_path='+schema);
  const seed={minimumSubtotalCents:3000,cardapio:[{id:'lanches',nome:'Lanches',itens:[{id:'lanche',nome:'Lanche',desc:'',preco:15}]}]};
  let a,b;
  try{
    a=await createPostgresStore(url.href,seed);b=await createPostgresStore(url.href,seed);
    await Promise.all([a.ensureAdmin('82619304'),b.ensureAdmin('82619304')]);
    const token=await a.login('82619304');assert.equal(await b.authenticated(token),true);
    const body={customer:'Cliente teste',phone:'87999999999',fulfillment:'retirada',paymentMethod:'dinheiro',needsChange:true,changeForCents:5000,notes:'Sem cebola',items:[{id:'lanche',qty:2}],expectedTotalCents:3000};
    const key=randomUUID(),pair=await Promise.all([a.placeOrder(body,key),b.placeOrder(body,key)]);
    assert.equal(pair[0].id,pair[1].id);assert.equal(pair.filter(item=>item.replayed).length,1);assert.equal((await a.orders()).length,1);
    const row=await b.order(pair[0].id);assert.equal(row.totalCents,3000);assert.equal(row.changeForCents,5000);assert.equal(row.notes,'Sem cebola');
    await assert.rejects(()=>a.placeOrder({...body,notes:'Outro'},key),{status:409});
    await assert.rejects(()=>a.placeOrder({...body,items:[{id:'lanche',qty:1}],expectedTotalCents:1500},randomUUID()),{status:409});
    const updates=await Promise.allSettled([a.changeStatus(row.id,{status:'confirmado',version:1}),b.changeStatus(row.id,{status:'cancelado',version:1})]);
    assert.equal(updates.filter(item=>item.status==='fulfilled').length,1);
    assert.equal(updates.find(item=>item.status==='rejected').reason.status,409);
    assert.equal((await b.track(row.id,pair[0].trackingToken)).history.length,2);
    assert.equal(await a.consumeRateLimit('ip',2,60000),true);assert.equal(await b.consumeRateLimit('ip',2,60000),true);assert.equal(await a.consumeRateLimit('ip',2,60000),false);
    await a.updateStoreStatus({acceptingOrders:false});await assert.rejects(()=>b.placeOrder(body,randomUUID()),{status:409});
    await a.close();a=await createPostgresStore(url.href,seed);assert.equal((await a.order(row.id)).changeForCents,5000);assert.equal((await a.catalog()).canOrder,false);
    await b.logout(token);assert.equal(await a.authenticated(token),false);
  }finally{
    await a?.close();await b?.close();
    if(!/^mdl_test_[a-f0-9]{32}$/.test(schema))throw Error('Schema de teste inválido');
    await control.query('DROP SCHEMA '+schema+' CASCADE');await control.end();
  }
});
