import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createFirestoreStore} from '../lib/firestore-store.mjs';
import {createVercelHandler} from '../api/index.mjs';

// Contract double: atomic transactions and Firestore's read-before-write rule.
// These tests do not authenticate against the user's live Firebase project.
function memoryFirestore(){
  let rows=new Map(),queue=Promise.resolve();
  const snap=(reference,map=rows)=>({exists:map.has(reference.path),data:()=>structuredClone(map.get(reference.path))});
  const db={collection(name){return {
    doc(id){const reference={path:name+'/'+id};return Object.assign(reference,{get:async()=>snap(reference),set:async value=>{rows.set(reference.path,structuredClone(value));},delete:async()=>{rows.delete(reference.path);}});},
    orderBy(field,direction){return {limit(max){return {get:async()=>({docs:[...rows].filter(([key])=>key.startsWith(name+'/')).map(([,value])=>value).sort((a,b)=>direction==='desc'?b[field].localeCompare(a[field]):a[field].localeCompare(b[field])).slice(0,max).map(value=>({data:()=>structuredClone(value)}))})};}};}
  };},getAll:async(...references)=>references.map(reference=>snap(reference)),terminate:async()=>{},runTransaction(fn){
    const result=queue.then(async()=>{
      const copy=structuredClone(rows);let writing=false;
      const tx={get:async reference=>{assert.equal(writing,false,'read after write');return snap(reference,copy);},getAll:async(...references)=>{assert.equal(writing,false,'read after write');return references.map(reference=>snap(reference,copy));},set(reference,value){writing=true;copy.set(reference.path,structuredClone(value));}};
      const value=await fn(tx);rows=copy;return value;
    });queue=result.catch(()=>{});return result;
  }};return db;
}
const seed={minimumSubtotalCents:3000,cardapio:[{id:'lanches',nome:'Lanches',itens:[{id:'lanche',nome:'Lanche',desc:'',preco:15}]}]};
const body=()=>({customer:'Cliente',phone:'87999999999',fulfillment:'retirada',paymentMethod:'dinheiro',needsChange:true,changeForCents:5000,notes:'Sem cebola',items:[{id:'lanche',qty:2}],expectedTotalCents:3000});

test('Firestore: persistência entre instâncias, concorrência, privacidade, status e autenticação',async()=>{
  const db=memoryFirestore(),a=await createFirestoreStore(db,seed),b=await createFirestoreStore(db,seed);
  await a.ensureAdmin('82619304');await b.ensureAdmin('93720415');
  await assert.rejects(()=>b.login('93720415'),{status:401});
  const token=await a.login('82619304');assert.equal(await b.authenticated(token),true);
  const key=randomUUID(),pair=await Promise.all([a.placeOrder(body(),key),b.placeOrder(body(),key)]);
  assert.equal(pair[0].id,pair[1].id);assert.equal(pair.filter(row=>row.replayed).length,1);
  assert.match(pair[0].id,/^[a-f0-9-]{36}$/); // Existing history and print pages accept this format.
  assert.equal((await a.orders()).length,1);assert.equal(pair[0].customer,undefined);assert.equal(pair[0].trackingHash,undefined);
  const row=await b.order(pair[0].id);assert.equal(row.notes,'Sem cebola');assert.equal(row.changeForCents,5000);assert.equal(row.totalCents,3000);
  assert.equal((await b.track(row.id,pair[0].trackingToken)).status,'novo');
  await assert.rejects(()=>b.track(row.id,'errado'),{status:404});
  await assert.rejects(()=>a.placeOrder({...body(),notes:'Outro'},key),{status:409});
  const changed=await a.changeStatus(row.id,{version:1,status:'confirmado'});assert.equal(changed.version,2);
  await assert.rejects(()=>b.changeStatus(row.id,{version:1,status:'cancelado'}),{status:409});
  assert.equal((await b.track(row.id,pair[0].trackingToken)).history.length,2);
  await b.logout(token);assert.equal(await a.authenticated(token),false);
  assert.equal(await a.consumeRateLimit('ip',2,60000),true);assert.equal(await b.consumeRateLimit('ip',2,60000),true);assert.equal(await a.consumeRateLimit('ip',2,60000),false);
});

test('Firestore: valida preços, mínimo, troco e fechamento; reinício preserva alterações',async()=>{
  const db=memoryFirestore(),store=await createFirestoreStore(db,seed);
  await assert.rejects(()=>store.placeOrder({...body(),items:[{id:'lanche',qty:1}],expectedTotalCents:1500},randomUUID()),{status:409});
  await assert.rejects(()=>store.placeOrder({...body(),expectedTotalCents:2900},randomUUID()),{status:409});
  await assert.rejects(()=>store.placeOrder({...body(),changeForCents:100},randomUUID()),{status:400});
  await assert.rejects(()=>store.placeOrder({...body(),fulfillment:'entrega'},randomUUID()),{status:400});
  await store.updateProduct('lanche',{priceCents:1600,active:true});
  const restarted=await createFirestoreStore(db,seed);assert.equal((await restarted.catalog()).cardapio[0].itens[0].preco,16);
  await restarted.updateStoreStatus({acceptingOrders:false});assert.equal((await store.catalog()).canOrder,false);
  await assert.rejects(()=>store.placeOrder(body(),randomUUID()),{status:409});assert.equal((await store.orders()).length,0);
});

test('Vercel: Firestore exige credenciais próprias sem depender de Turso',async()=>{
  let initialized=false,payload,status;
  const env={DATABASE_PROVIDER:'firestore',FIREBASE_PROJECT_ID:'mestredoslanches',PUBLIC_ORIGIN:'https://cliente.example',MDL_ADMIN_PASSWORD:'82619304'};
  const response={writeHead(value){status=value;},end(value){payload=JSON.parse(value);}};
  await createVercelHandler({env,initializeApp:async()=>{initialized=true;}})({},response);
  assert.equal(status,503);assert.deepEqual(payload.missing,['FIREBASE_CLIENT_EMAIL','FIREBASE_PRIVATE_KEY']);assert.equal(initialized,false);
  Object.assign(env,{FIREBASE_CLIENT_EMAIL:'teste@mestredoslanches.iam.gserviceaccount.com',FIREBASE_PRIVATE_KEY:'somente-teste'});
  const handler=createVercelHandler({env,initializeApp:async()=>{initialized=true;return {server:{listeners:()=>[(req,res)=>{res.writeHead(200);res.end('{"ok":true}');}]}};}});
  await handler({url:'/api/index?route=health'},response);assert.equal(status,200);assert.equal(initialized,true);
});

test('Firestore: novo lanche aparece e pode ser comprado em outra instancia',async()=>{
 const db=memoryFirestore(),a=await createFirestoreStore(db,seed),b=await createFirestoreStore(db,seed);
 const {id}=await a.createProduct({name:'Especial',description:'Carne e queijo',category:'lanches',priceCents:3500,active:true});
 const item=(await b.catalog()).cardapio[0].itens.find(item=>item.id===id);assert.equal(item.preco,35);
 await b.updateProduct(id,{priceCents:3600,active:true});
 const order=await b.placeOrder({...body(),paymentMethod:'pix',needsChange:false,changeForCents:null,items:[{id,qty:1}],expectedTotalCents:3600},randomUUID());assert.equal(order.totalCents,3600);
});
