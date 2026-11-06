export function productImage(value){
  if(value===undefined)return undefined;
  if(value===null||value==='')return null;
  if(typeof value!=='string'||value.length>400000||!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value))throw Object.assign(Error('Foto inválida. Escolha JPG, PNG ou WebP.'),{status:400});
  return value;
}
import {randomUUID} from 'node:crypto';
export function newProduct(body,seed){
  const fail=()=>{throw Object.assign(Error('Confira nome, ingredientes, categoria, preco e disponibilidade do lanche.'),{status:400});};
  const clean=(value,min,max)=>{if(typeof value!=='string'||value.trim().length<min||value.trim().length>max||/[\x00-\x1f]/.test(value))fail();return value.trim();};
  const nome=clean(body.name,2,100),desc=clean(body.description,1,1000);
  const group=seed.cardapio.find(group=>group.id===body.category);
  if(!group||!Number.isSafeInteger(body.priceCents)||body.priceCents<1||body.priceCents>1000000||typeof body.active!=='boolean')fail();
  return {id:'lanche-'+randomUUID(),nome,desc,category:group.id,categoryName:group.nome,priceCents:body.priceCents,active:body.active,imagem:productImage(body.image)??null};
}
