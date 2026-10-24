import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, createHmac, scryptSync, timingSafeEqual } from 'node:crypto';
import { addressFields } from './address.mjs';

export const hash = text => createHash('sha256').update(text).digest('hex');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const text = (value, min, max, label) => {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail(`Confira ${label}.`);
  return value.trim();
};
const cents = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000;
const transitions = {
  novo:['confirmado','cancelado'], confirmado:['preparando','cancelado'], preparando:['saiu','pronto','cancelado'], saiu:['concluido'], pronto:['concluido'], concluido:[], cancelado:[]
};

export function createStore(filename, seed, { now = () => new Date() } = {}) {
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, category TEXT NOT NULL, category_name TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, price INTEGER, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY CHECK(id=1), salt TEXT NOT NULL, password TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, token TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, customer TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL, fulfillment TEXT NOT NULL, notes TEXT NOT NULL, items TEXT NOT NULL, subtotal INTEGER NOT NULL, delivery_fee INTEGER NOT NULL, total INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), status TEXT NOT NULL, at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at);`);
  if (!db.prepare('PRAGMA table_info(orders)').all().some(column=>column.name==='payment_method')) db.exec('ALTER TABLE orders ADD COLUMN payment_method TEXT');
  if (!db.prepare('PRAGMA table_info(orders)').all().some(column=>column.name==='address_validation')) db.exec('ALTER TABLE orders ADD COLUMN address_validation TEXT');
  if (!db.prepare('PRAGMA table_info(products)').all().some(column=>column.name==='archived')) db.exec('ALTER TABLE products ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
  for(const column of ['needs_change','change_for']) if(!db.prepare('PRAGMA table_info(orders)').all().some(item=>item.name===column)) db.exec('ALTER TABLE orders ADD COLUMN '+column+' INTEGER');
  const definitions=new Map(seed.cardapio.flatMap(group=>group.itens.map((item,index)=>[item.id || `${group.id}-${index}`,item])));
  const insert = db.prepare('INSERT OR IGNORE INTO products(id,category,category_name,name,description,price) VALUES(?,?,?,?,?,?)');
  for (const group of seed.cardapio) for (const [index,item] of group.itens.entries()) insert.run(item.id || `${group.id}-${index}`,group.id,group.nome,item.nome,item.desc,Number.isFinite(item.preco) ? Math.round(item.preco*100) : null);
  db.prepare('INSERT OR IGNORE INTO settings VALUES(?,?)').run('store',JSON.stringify({ deliveryFeeCents:0, minimumSubtotalCents:seed.minimumSubtotalCents ?? null, acceptingOrders:true }));
  const initialSettings=JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get('store').value);
  if (initialSettings.minimumSubtotalCents == null && Number.isSafeInteger(seed.minimumSubtotalCents)) {
    initialSettings.minimumSubtotalCents=seed.minimumSubtotalCents;
    db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(initialSettings),'store');
  }
  db.prepare('INSERT OR IGNORE INTO settings VALUES(?,?)').run('tracking_secret',randomBytes(32).toString('hex'));
  const trackingSecret=db.prepare('SELECT value FROM settings WHERE key=?').get('tracking_secret').value;

  function settings() { return {minimumSubtotalCents:null,...JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get('store').value)}; }
  function catalog() {
    const rows = db.prepare('SELECT * FROM products WHERE archived=0 ORDER BY rowid').all();
    const groups = [];
    for (const row of rows) {
      let group = groups.find(item => item.id === row.category);
      if (!group) { group={id:row.category,nome:row.category_name,itens:[]};groups.push(group); }
      const definition=definitions.get(row.id);
      group.itens.push({imagem:definition?.imagem ?? null,imagemAlt:definition?.imagemAlt ?? null,id:row.id,nome:row.name,desc:row.description,preco:row.price === null ? null : row.price/100,ativo:!!row.active,pedidoPendente:definition?.pedidoPendente===true,precoInicial:Number.isFinite(definition?.precoInicial)?definition.precoInicial:null});
    }
    for (const group of groups) if (group.id==='pizzas') group.itens.sort((a,b)=>Number(b.id.endsWith('-8'))-Number(a.id.endsWith('-8')));
    const config=settings();
    return { cardapio:groups, ...config, canOrder:config.acceptingOrders };
  }
  function updateProduct(id, body) {
    if (!db.prepare('SELECT id FROM products WHERE id=?').get(id)) fail('Produto não encontrado.',404);
    if (body.priceCents !== null && !cents(body.priceCents)) fail('Preço inválido.');
    if (typeof body.active !== 'boolean') fail('Disponibilidade inválida.');
    db.prepare('UPDATE products SET price=?,active=? WHERE id=?').run(body.priceCents,Number(body.active),id);
  }
  function updateSettings(body) {
    if (body.deliveryFeeCents !== null && !cents(body.deliveryFeeCents)) fail('Taxa de entrega inválida.');
    if (body.minimumSubtotalCents !== null && (!cents(body.minimumSubtotalCents) || body.minimumSubtotalCents < 1)) fail('Pedido mínimo inválido.');
    if (typeof body.acceptingOrders !== 'boolean') fail('Disponibilidade da loja inválida.');
    db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify({deliveryFeeCents:body.deliveryFeeCents,minimumSubtotalCents:body.minimumSubtotalCents,acceptingOrders:body.acceptingOrders}),'store');
    return settings();
  }
  function updateStoreStatus(body) {
    if (typeof body.acceptingOrders !== 'boolean') fail('Disponibilidade da loja inválida.');
    const config={...settings(),acceptingOrders:body.acceptingOrders};
    db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(config),'store');
    return config;
  }
  const hasAdmin = () => !!db.prepare('SELECT id FROM admin WHERE id=1').get();
  function setup(password) {
    if (hasAdmin()) fail('O acesso já foi configurado.',409);
    text(password,12,128,'uma senha com pelo menos 12 caracteres');
    const salt = randomBytes(16).toString('hex');
    db.prepare('INSERT INTO admin VALUES(1,?,?)').run(salt,scryptSync(password,salt,64).toString('hex'));
  }
  function login(password) {
    const row=db.prepare('SELECT * FROM admin WHERE id=1').get();
    if (!row || typeof password !== 'string' || password.length > 128 || !timingSafeEqual(scryptSync(password,row.salt,64),Buffer.from(row.password,'hex'))) fail('Senha incorreta.',401);
    const token = randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES(?,?)').run(hash(token),Date.now()+12*60*60*1000);
    return token;
  }
  const authenticated = token => typeof token === 'string' && !!db.prepare('SELECT token FROM sessions WHERE token=? AND expires>?').get(hash(token),Date.now());
  const logout = token => { if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(hash(token)); };
  function view(row, admin = false) {
    if (!row) return null;
    const result={id:row.id,code:row.code,items:JSON.parse(row.items),fulfillment:row.fulfillment,paymentMethod:row.payment_method,needsChange:row.needs_change===null?null:!!row.needs_change,changeForCents:row.change_for,subtotalCents:row.subtotal,deliveryFeeCents:row.delivery_fee,totalCents:row.total,status:row.status,createdAt:row.created_at,updatedAt:row.updated_at,version:row.version,history:db.prepare('SELECT status,at FROM history WHERE order_id=? ORDER BY id').all(row.id)};
    if (admin) Object.assign(result,{customer:row.customer,phone:row.phone,address:row.address,notes:row.notes});
    if (admin) result.addressValidation=row.address_validation?JSON.parse(row.address_validation):null;
    return result;
  }
  function placeOrder(body, key, {verifiedAddress}={}) {
    if (typeof key !== 'string' || !/^[a-zA-Z0-9-]{20,80}$/.test(key)) fail('Identificador de pedido inválido.');
    const customer=text(body.customer,2,80,'seu nome');
    const phone=text(body.phone,10,25,'seu WhatsApp').replace(/\D/g,'');
    if (!/^(?:55)?\d{10,11}$/.test(phone)) fail('Informe um WhatsApp com DDD.');
    if (!['entrega','retirada'].includes(body.fulfillment)) fail('Selecione entrega ou retirada.');
    const paymentMethod=body.paymentMethod;
    if (!['pix','cartao','dinheiro'].includes(paymentMethod)) fail('Selecione Pix, cartão ou dinheiro como forma de pagamento.');
    if(body.needsChange!==undefined && typeof body.needsChange!=='boolean')fail('Informe se precisa de troco.');
    const needsChange=paymentMethod==='dinheiro' ? body.needsChange ?? false : false;
    const changeForCents=needsChange?body.changeForCents:null;
    if(paymentMethod!=='dinheiro' && (body.needsChange===true || body.changeForCents!=null))fail('Troco somente para pagamento em dinheiro.');
    if(needsChange && (!cents(changeForCents) || changeForCents < body.expectedTotalCents))fail('O valor para troco deve ser igual ou maior que o total do pedido.');
    if(!needsChange && body.changeForCents!=null)fail('Selecione precisa de troco antes de informar o valor.');
    const details=body.fulfillment==='entrega'?addressFields(body.deliveryAddress):null;
    const address=details ? verifiedAddress?.formatted : '';
    const notes=text(body.notes ?? '',0,1000,'as observações');
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100) fail('A sacola está vazia ou é muito grande.');
    const quantities=new Map();
    for (const line of body.items) {
      if (!line || typeof line.id !== 'string' || !Number.isInteger(line.qty) || line.qty < 1 || line.qty > 99 || quantities.has(line.id)) fail('Confira os itens e as quantidades.');
      quantities.set(line.id,line.qty);
    }
    const fingerprint=hash(JSON.stringify({customer,phone,address:details,notes,fulfillment:body.fulfillment,paymentMethod,...(body.needsChange!==undefined?{needsChange,changeForCents}:{}),items:[...quantities].sort()}));
    const previous=db.prepare('SELECT * FROM orders WHERE request_key=?').get(key);
    const trackingToken=createHmac('sha256',trackingSecret).update(key).digest('base64url');
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail('Esse identificador já foi usado em outro pedido.',409);
      return {...view(previous),trackingToken,replayed:true};
    }
    const config=settings();
    if(details && (!verifiedAddress || verifiedAddress.cep!==details.cep || !['city','street'].includes(verifiedAddress.level) || typeof address!=='string'))fail('Consulte e confirme o endereço antes de enviar o pedido.');
    if (!config.acceptingOrders) fail('A loja está fechada no momento. Tente novamente mais tarde.',409);
    const items=[];
    for (const [id,qty] of quantities) {
      const item=db.prepare('SELECT * FROM products WHERE id=?').get(id);
      if (!item || !item.active || item.archived) fail('Um dos produtos não está disponível. Atualize o cardápio.',409);
      if (definitions.get(id)?.pedidoPendente) fail('As opções deste combo ainda precisam ser confirmadas pela lanchonete. Escolha outro item ou entre em contato.',409);
      if (item.price === null) fail('O preço de um dos produtos ainda não está disponível. Entre em contato com a lanchonete.',409);
      items.push({id,name:item.name,qty,unitPriceCents:item.price});
    }
    if (body.fulfillment === 'entrega' && config.deliveryFeeCents === null) fail('A taxa de entrega ainda não está disponível. Escolha retirada ou consulte a lanchonete.',409);
    const subtotal=items.reduce((sum,item)=>sum+item.qty*item.unitPriceCents,0);
    if (config.minimumSubtotalCents === null) fail('O pedido mínimo ainda não foi informado pela lanchonete.',409);
    if (subtotal < config.minimumSubtotalCents) fail(`O pedido mínimo é ${new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(config.minimumSubtotalCents/100)} em produtos.`,409);
    const fee=body.fulfillment === 'entrega' ? config.deliveryFeeCents : 0;
    if (!Number.isSafeInteger(body.expectedTotalCents) || body.expectedTotalCents !== subtotal+fee) fail('Os valores foram atualizados. Revise o pedido antes de enviar.',409);
    const id=randomUUID(),code=randomBytes(5).toString('hex').toUpperCase(),now=new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO orders(id,code,token,request_key,fingerprint,customer,phone,address,fulfillment,payment_method,notes,items,subtotal,delivery_fee,total,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,code,hash(trackingToken),key,fingerprint,customer,phone,address,body.fulfillment,paymentMethod,notes,JSON.stringify(items),subtotal,fee,subtotal+fee,'novo',now,now);
      db.prepare('UPDATE orders SET needs_change=?,change_for=? WHERE id=?').run(paymentMethod==='dinheiro'?Number(needsChange):null,changeForCents,id);
      db.prepare('INSERT INTO history(order_id,status,at) VALUES(?,?,?)').run(id,'novo',now);
      if(details)db.prepare('UPDATE orders SET address_validation=? WHERE id=?').run(JSON.stringify({cep:verifiedAddress.cep,level:verifiedAddress.level,city:verifiedAddress.city,state:verifiedAddress.state}),id);
      db.exec('COMMIT');
    } catch(error) { db.exec('ROLLBACK');throw error; }
    return {...view(db.prepare('SELECT * FROM orders WHERE id=?').get(id)),trackingToken,replayed:false};
  }
  function track(id,token) {
    if (typeof token !== 'string') fail('Pedido não encontrado.',404);
    const row=db.prepare('SELECT * FROM orders WHERE id=? AND token=?').get(id,hash(token));
    if (!row) fail('Pedido não encontrado.',404);
    return view(row);
  }
  function orders() { return db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200').all().map(row=>view(row,true)); }
  function order(id) {
    const row=db.prepare('SELECT * FROM orders WHERE id=?').get(id);
    if (!row) fail('Pedido não encontrado.',404);
    return view(row,true);
  }
  function changeStatus(id,body) {
    const row=db.prepare('SELECT * FROM orders WHERE id=?').get(id);
    if (!row) fail('Pedido não encontrado.',404);
    if (body.version !== row.version) fail('O pedido foi atualizado em outra tela. Atualize o painel.',409);
    if (!transitions[row.status]?.includes(body.status)) fail('Essa mudança de status não é permitida.',409);
    const validation=row.address_validation?JSON.parse(row.address_validation):null;
    if(body.status==='confirmado' && row.fulfillment==='entrega' && validation?.level!=='street' && body.addressReviewed!==true)fail('Confira a rua com o cliente e marque a confirmação do endereço antes de aceitar o pedido.');
    if ((body.status === 'saiu' && row.fulfillment !== 'entrega') || (body.status === 'pronto' && row.fulfillment !== 'retirada')) fail('Status incompatível com o tipo de pedido.');
    const now=new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE orders SET status=?,updated_at=?,version=version+1 WHERE id=?').run(body.status,now,id);
      if(body.status==='confirmado' && row.fulfillment==='entrega' && validation?.level!=='street')db.prepare('UPDATE orders SET address_validation=? WHERE id=?').run(JSON.stringify({...validation,reviewedAt:now}),id);
      db.prepare('INSERT INTO history(order_id,status,at) VALUES(?,?,?)').run(id,body.status,now);
      db.exec('COMMIT');
    } catch(error) { db.exec('ROLLBACK');throw error; }
    return view(db.prepare('SELECT * FROM orders WHERE id=?').get(id),true);
  }
  return { catalog,updateProduct,settings,updateSettings,updateStoreStatus,hasAdmin,setup,login,authenticated,logout,placeOrder,track,orders,order,changeStatus,close:()=>db.close() };
}
