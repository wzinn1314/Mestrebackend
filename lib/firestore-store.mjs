import {randomBytes, createHash, createHmac, scryptSync, timingSafeEqual} from 'node:crypto';
import {addressFields} from './address.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const cents=value=>Number.isSafeInteger(value)&&value>=0&&value<=1000000;
const text=(value,min,max,label)=>{
  if(typeof value!=='string'||value.trim().length<min||value.trim().length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))fail(`Confira ${label}.`);
  return value.trim();
};
const transitions={novo:['confirmado','cancelado'],confirmado:['preparando','cancelado'],preparando:['saiu','pronto','cancelado'],saiu:['concluido'],pronto:['concluido'],concluido:[],cancelado:[]};

// Only the server can access these collections. No customer data is exposed to the web SDK.
export async function createFirestoreStore(db,seed){
  const ref=(collection,id)=>db.collection(collection).doc(id);
  const get=async reference=>(await reference.get()).data();
  const configRef=ref('mdl_settings','store'),secretRef=ref('mdl_settings','tracking'),adminRef=ref('mdl_private','admin');
  const definitions=seed.cardapio.flatMap(group=>group.itens.map((item,index)=>({...item,id:item.id||group.id+'-'+index,category:group.id,categoryName:group.nome})));
  await db.runTransaction(async tx=>{
    const references=[configRef,secretRef,...definitions.map(item=>ref('mdl_products',item.id))];
    const snapshots=await tx.getAll(...references);
    if(!snapshots[0].exists)tx.set(configRef,{deliveryFeeCents:0,minimumSubtotalCents:seed.minimumSubtotalCents??3000,acceptingOrders:true});
    if(!snapshots[1].exists)tx.set(secretRef,{value:randomBytes(32).toString('hex')});
    definitions.forEach((item,index)=>{if(!snapshots[index+2].exists)tx.set(references[index+2],{priceCents:Number.isFinite(item.preco)?Math.round(item.preco*100):null,active:true});});
  });
  const trackingSecret=(await get(secretRef)).value;
  const settings=()=>get(configRef);
  async function catalog(){
    const snapshots=definitions.length?await db.getAll(...definitions.map(item=>ref('mdl_products',item.id))):[];
    const groups=[];
    definitions.forEach((item,index)=>{
      const product=snapshots[index].data();
      let group=groups.find(group=>group.id===item.category);
      if(!group){group={id:item.category,nome:item.categoryName,itens:[]};groups.push(group);}
      group.itens.push({id:item.id,nome:item.nome,desc:item.desc,imagem:item.imagem??null,imagemAlt:item.imagemAlt??null,preco:product.priceCents===null?null:product.priceCents/100,ativo:product.active,pedidoPendente:item.pedidoPendente===true,precoInicial:Number.isFinite(item.precoInicial)?item.precoInicial:null});
    });
    for(const group of groups)if(group.id==='pizzas')group.itens.sort((a,b)=>Number(b.id.endsWith('-8'))-Number(a.id.endsWith('-8')));
    const config=await settings();return {cardapio:groups,...config,canOrder:config.acceptingOrders};
  }
  const hasAdmin=async()=>!!await get(adminRef);
  async function setup(password,onlyIfAbsent=false){
    if(typeof password!=='string'||!/^\d{8}$/.test(password))text(password,12,128,'uma senha com 8 números ou pelo menos 12 caracteres');
    return db.runTransaction(async tx=>{
      if((await tx.get(adminRef)).exists){if(onlyIfAbsent)return;fail('O acesso já foi configurado.',409);}
      const salt=randomBytes(16).toString('hex');tx.set(adminRef,{salt,password:scryptSync(password,salt,64).toString('hex')});
    });
  }
  async function login(password){
    const admin=await get(adminRef);
    if(!admin||typeof password!=='string'||password.length>128||!timingSafeEqual(scryptSync(password,admin.salt,64),Buffer.from(admin.password,'hex')))fail('Senha incorreta.',401);
    const token=randomBytes(32).toString('base64url');
    await ref('mdl_sessions',hash(token)).set({expires:Date.now()+43200000});return token;
  }
  const authenticated=async token=>typeof token==='string'&&((await get(ref('mdl_sessions',hash(token))))?.expires??0)>Date.now();
  const logout=async token=>{if(token)await ref('mdl_sessions',hash(token)).delete();};
  function view(row,admin=false){
    if(!row)return null;
    const {trackingHash,fingerprint,customer,phone,address,notes,addressValidation,...result}=row;
    if(admin)Object.assign(result,{customer,phone,address,notes,addressValidation});return result;
  }
  async function placeOrder(body,key,{verifiedAddress}={}){
    if(typeof key!=='string'||!/^[a-zA-Z0-9-]{20,80}$/.test(key))fail('Identificador de pedido inválido.');
    const customer=text(body.customer,2,80,'seu nome'),phone=text(body.phone,10,25,'seu WhatsApp').replace(/\D/g,'');
    if(!/^(?:55)?\d{10,11}$/.test(phone))fail('Informe um WhatsApp com DDD.');
    if(!['entrega','retirada'].includes(body.fulfillment))fail('Selecione entrega ou retirada.');
    const paymentMethod=body.paymentMethod;
    if(!['pix','cartao','dinheiro'].includes(paymentMethod))fail('Selecione Pix, cartão ou dinheiro como forma de pagamento.');
    if(body.needsChange!==undefined&&typeof body.needsChange!=='boolean')fail('Informe se precisa de troco.');
    const needsChange=paymentMethod==='dinheiro'?(body.needsChange??false):false,changeForCents=needsChange?body.changeForCents:null;
    if(paymentMethod!=='dinheiro'&&(body.needsChange===true||body.changeForCents!=null))fail('Troco somente para pagamento em dinheiro.');
    if(needsChange&&(!cents(changeForCents)||changeForCents<body.expectedTotalCents))fail('O valor para troco deve ser igual ou maior que o total do pedido.');
    if(!needsChange&&body.changeForCents!=null)fail('Selecione precisa de troco antes de informar o valor.');
    const details=body.fulfillment==='entrega'?addressFields(body.deliveryAddress):null;
    const notes=text(body.notes??'',0,1000,'as observações');
    if(!Array.isArray(body.items)||!body.items.length||body.items.length>100)fail('Confira os itens da sacola.');
    const quantities=new Map();
    for(const line of body.items){
      if(!line||typeof line.id!=='string'||!Number.isInteger(line.qty)||line.qty<1||line.qty>99||quantities.has(line.id)||!definitions.some(item=>item.id===line.id))fail('Confira os itens e as quantidades.');
      quantities.set(line.id,line.qty);
    }
    const fingerprint=hash(JSON.stringify({customer,phone,address:details,notes,fulfillment:body.fulfillment,paymentMethod,needsChange,changeForCents,items:[...quantities].sort()}));
    const trackingToken=createHmac('sha256',trackingSecret).update(key).digest('base64url');
    // A deterministic document ID makes concurrent retries refer to the same order.
    const digest=hash(key),id=[digest.slice(0,8),digest.slice(8,12),digest.slice(12,16),digest.slice(16,20),digest.slice(20,32)].join('-'),orderRef=ref('mdl_orders',id);
    return db.runTransaction(async tx=>{
      const [previous,configSnapshot,...products]=await tx.getAll(orderRef,configRef,...[...quantities.keys()].map(id=>ref('mdl_products',id)));
      if(previous.exists){const row=previous.data();if(row.fingerprint!==fingerprint)fail('Esse identificador já foi usado em outro pedido.',409);return {...view(row),trackingToken,replayed:true};}
      const config=configSnapshot.data();
      if(details&&(!verifiedAddress||verifiedAddress.cep!==details.cep||!['city','street'].includes(verifiedAddress.level)||typeof verifiedAddress.formatted!=='string'))fail('Consulte e confirme o endereço antes de enviar o pedido.');
      if(!config.acceptingOrders)fail('A loja está fechada no momento.',409);
      const items=[...quantities].map(([id,qty],index)=>{
        const product=products[index].data(),definition=definitions.find(item=>item.id===id);
        if(!product?.active||definition.pedidoPendente||!cents(product.priceCents))fail('Um produto está indisponível. Atualize o cardápio.',409);
        return {id,name:definition.nome,qty,unitPriceCents:product.priceCents};
      });
      const subtotalCents=items.reduce((sum,item)=>sum+item.qty*item.unitPriceCents,0);
      if(!cents(config.minimumSubtotalCents)||subtotalCents<config.minimumSubtotalCents)fail('O pedido não atingiu o valor mínimo da loja.',409);
      const deliveryFeeCents=body.fulfillment==='entrega'?config.deliveryFeeCents:0;
      if(!cents(deliveryFeeCents))fail('A taxa de entrega ainda não está disponível.',409);
      const totalCents=subtotalCents+deliveryFeeCents;
      if(!Number.isSafeInteger(body.expectedTotalCents)||body.expectedTotalCents!==totalCents)fail('Os valores foram atualizados. Revise o pedido antes de enviar.',409);
      const now=new Date().toISOString();
      const row={id,code:digest.slice(0,10).toUpperCase(),trackingHash:hash(trackingToken),fingerprint,customer,phone,address:details?verifiedAddress.formatted:'',notes,fulfillment:body.fulfillment,paymentMethod,needsChange:paymentMethod==='dinheiro'?needsChange:null,changeForCents,items,subtotalCents,deliveryFeeCents,totalCents,status:'novo',createdAt:now,updatedAt:now,version:1,history:[{status:'novo',at:now}],addressValidation:details?{cep:verifiedAddress.cep,level:verifiedAddress.level,city:verifiedAddress.city,state:verifiedAddress.state}:null};
      tx.set(orderRef,row);return {...view(row),trackingToken,replayed:false};
    });
  }
  async function track(id,token){
    if(typeof token!=='string'||typeof id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))fail('Pedido não encontrado.',404);
    const row=await get(ref('mdl_orders',id));if(!row||row.trackingHash!==hash(token))fail('Pedido não encontrado.',404);return view(row);
  }
  const orderRef=id=>{if(typeof id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))fail('Pedido não encontrado.',404);return ref('mdl_orders',id);};
  const orders=async()=>(await db.collection('mdl_orders').orderBy('createdAt','desc').limit(200).get()).docs.map(doc=>view(doc.data(),true));
  async function order(id){const row=await get(orderRef(id));if(!row)fail('Pedido não encontrado.',404);return view(row,true);}
  async function changeStatus(id,body){return db.runTransaction(async tx=>{
    const reference=orderRef(id),row=(await tx.get(reference)).data();if(!row)fail('Pedido não encontrado.',404);
    if(body.version!==row.version)fail('O pedido foi atualizado em outra tela. Atualize o painel.',409);
    if(!transitions[row.status]?.includes(body.status))fail('Essa mudança de status não é permitida.',409);
    if(body.status==='confirmado'&&row.fulfillment==='entrega'&&row.addressValidation?.level!=='street'&&body.addressReviewed!==true)fail('Confira a rua com o cliente antes de aceitar o pedido.');
    if((body.status==='saiu'&&row.fulfillment!=='entrega')||(body.status==='pronto'&&row.fulfillment!=='retirada'))fail('Status incompatível com o tipo de pedido.');
    const now=new Date().toISOString();row.status=body.status;row.updatedAt=now;row.version++;row.history.push({status:body.status,at:now});
    if(body.status==='confirmado'&&row.fulfillment==='entrega'&&row.addressValidation?.level!=='street')row.addressValidation={...row.addressValidation,reviewedAt:now};
    tx.set(reference,row);return view(row,true);
  });}
  async function updateProduct(id,body){
    if(!definitions.some(item=>item.id===id))fail('Produto não encontrado.',404);
    if((body.priceCents!==null&&!cents(body.priceCents))||typeof body.active!=='boolean')fail('Preço ou disponibilidade inválidos.');
    await ref('mdl_products',id).set({priceCents:body.priceCents,active:body.active});
  }
  async function updateSettings(body){
    if((body.deliveryFeeCents!==null&&!cents(body.deliveryFeeCents))||(body.minimumSubtotalCents!==null&&(!cents(body.minimumSubtotalCents)||body.minimumSubtotalCents<1))||typeof body.acceptingOrders!=='boolean')fail('Configuração da loja inválida.');
    const value={deliveryFeeCents:body.deliveryFeeCents,minimumSubtotalCents:body.minimumSubtotalCents,acceptingOrders:body.acceptingOrders};await configRef.set(value);return value;
  }
  async function updateStoreStatus(body){
    if(typeof body.acceptingOrders!=='boolean')fail('Disponibilidade da loja inválida.');
    return db.runTransaction(async tx=>{const value={...(await tx.get(configRef)).data(),acceptingOrders:body.acceptingOrders};tx.set(configRef,value);return value;});
  }
  async function consumeRateLimit(key,max,interval){return db.runTransaction(async tx=>{
    const reference=ref('mdl_rate_limits',hash(key)),now=Date.now(),current=(await tx.get(reference)).data();
    if(current&&current.until>now&&current.count>=max)return false;
    const active=current&&current.until>now;tx.set(reference,{count:active?current.count+1:1,until:active?current.until:now+interval});return true;
  });}
  return {catalog,settings,hasAdmin,setup,ensureAdmin:password=>setup(password,true),login,authenticated,logout,placeOrder,track,orders,order,changeStatus,updateProduct,updateSettings,updateStoreStatus,consumeRateLimit,close:()=>db.terminate()};
}
