import { readFile,writeFile,mkdir,rename,access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const backendRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=JSON.parse(await readFile(path.join(backendRoot,'imports/cardapio/catalogo.json'),'utf8'));
const configPath=path.join(backendRoot,'config/loja.json');
const previousConfig=await readFile(configPath,'utf8');
const config={...JSON.parse(previousConfig),cardapio:source.cardapio,catalogSource:{type:'fotos-do-cardapio',date:'2026-10-23'}};
const ids=new Set();
for(const group of source.cardapio){
  if(!/^[a-z0-9-]+$/.test(group.id)||!group.nome)throw Error('Categoria inválida.');
  for(const item of group.itens){
    if(!/^[a-z0-9-]+$/.test(item.id)||ids.has(item.id)||!item.nome||typeof item.desc!=='string')throw Error('Produto inválido ou repetido.');
    if(item.preco!==null && (!Number.isFinite(item.preco)||item.preco<0))throw Error('Preço inválido.');
    ids.add(item.id);
  }
}
const dataPath=path.join(backendRoot,'data');await mkdir(dataPath,{recursive:true});
const dbPath=path.join(dataPath,'loja.sqlite');await access(dbPath);
const db=new DatabaseSync(dbPath);db.exec('PRAGMA busy_timeout=5000');
const backup=path.join(dataPath,`antes-cardapio-${Date.now()}.sqlite`);
db.exec(`VACUUM INTO '${backup.replaceAll("'","''")}'`);
try{
  db.exec('BEGIN IMMEDIATE');
  if(!db.prepare('PRAGMA table_info(products)').all().some(column=>column.name==='archived'))db.exec('ALTER TABLE products ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
  db.prepare('UPDATE products SET archived=1,active=0').run();
  const upsert=db.prepare('INSERT INTO products(id,category,category_name,name,description,price,active,archived) VALUES(?,?,?,?,?,?,1,0) ON CONFLICT(id) DO UPDATE SET category=excluded.category,category_name=excluded.category_name,name=excluded.name,description=excluded.description,price=excluded.price,active=1,archived=0');
  for(const group of source.cardapio)for(const item of group.itens)upsert.run(item.id,group.id,group.nome,item.nome,item.desc,item.preco===null?null:Math.round(item.preco*100));
  await writeFile(configPath+'.tmp',JSON.stringify(config,null,2)+'\n');await rename(configPath+'.tmp',configPath);
  db.exec('COMMIT');
}catch(error){try{db.exec('ROLLBACK');}catch{}await writeFile(configPath,previousConfig);throw error;}
finally{db.close();}
await writeFile(path.resolve(backendRoot,'../frontend/js/data.js'),'window.MDL = '+JSON.stringify(config,null,2)+';\n');
console.log(JSON.stringify({categorias:source.cardapio.length,produtos:ids.size,combosPendentes:source.cardapio.flatMap(group=>group.itens).filter(item=>item.pedidoPendente).length,backup:path.basename(backup)}));
