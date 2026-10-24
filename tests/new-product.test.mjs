import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createStore} from '../lib/store.mjs';
const seed={minimumSubtotalCents:3000,cardapio:[{id:'lanches',nome:'Lanches',itens:[]}]};
test('novo lanche: valida, persiste, permite editar e comprar depois de reiniciar',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'mdl-new-'));let store=createStore(path.join(dir,'store.sqlite'),seed);
 const body={name:'Lanche especial',description:'Pao, carne e queijo',category:'lanches',priceCents:3500,active:true};
 try{
  for(const patch of [{name:''},{description:''},{category:'inexistente'},{priceCents:-1},{priceCents:1.5},{active:'sim'}])assert.throws(()=>store.createProduct({...body,...patch}),{status:400});
  const {id}=store.createProduct(body);store.close();store=createStore(path.join(dir,'store.sqlite'),seed);
  const item=store.catalog().cardapio[0].itens[0];assert.equal(item.id,id);assert.equal(item.preco,35);assert.equal(item.nome,body.name);
  store.updateProduct(id,{priceCents:3600,active:true});
  const order=store.placeOrder({customer:'Cliente teste',phone:'87999999999',fulfillment:'retirada',paymentMethod:'pix',items:[{id,qty:1}],expectedTotalCents:3600},randomUUID());assert.equal(order.totalCents,3600);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
