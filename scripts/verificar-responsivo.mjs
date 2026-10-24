import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const directory=await mkdtemp(path.join(tmpdir(),'mdl-mobile-'));
const output=new URL('../data/mobile-check/',import.meta.url);await mkdir(output,{recursive:true});
const chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=9238','--user-data-dir='+directory,'about:blank'],{windowsHide:true,stdio:'ignore'});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let socket;
try{
  let target;
  for(let i=0;i<60;i++){try{target=await(await fetch('http://127.0.0.1:9238/json/new?about:blank',{method:'PUT'})).json();break;}catch{await pause(200);}}
  if(!target)throw Error('Chrome indisponível.');
  socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let counter=0;const pending=new Map();
  socket.onmessage=event=>{const message=JSON.parse(event.data),request=pending.get(message.id);if(request){pending.delete(message.id);message.error?request.reject(Error(message.error.message)):request.resolve(message.result);}};
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++counter;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>(await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result.value;
  await call('Page.enable');
  await call('Page.addScriptToEvaluateOnNewDocument',{source:"try{localStorage.setItem('mdl-customer-name','Cliente');sessionStorage.setItem('mdl-customer-name','Cliente');}catch{}"});
  const results=[];
  async function check(name,width){
    const issues=await evaluate(`(()=>{const width=innerWidth;return [...document.querySelectorAll('header,main,.product-card,.cart-panel,.modal-card,.field input,.field select,.admin-order,.product-editor,.client-tabs,.tracking-steps')].filter(el=>{const r=el.getBoundingClientRect();return r.width>0 && (r.left < -1 || r.right > width+1);}).map(el=>({tag:el.tagName,id:el.id,classes:el.className,right:Math.round(el.getBoundingClientRect().right),width}));})()`);
    results.push({screen:name,width,issues});
    await writeFile(new URL('resultado.json',output),JSON.stringify(results,null,2));
    if(width===320){const screenshot=await call('Page.captureScreenshot',{format:'png'});await writeFile(new URL(name+'-'+width+'.png',output),Buffer.from(screenshot.data,'base64'));}
  }
  for(const width of [320,390,768,1024]){
    await call('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});
    for(const page of ['index','pedidos','acompanhar','painel']){
      await call('Page.navigate',{url:'http://localhost:3000/'+page+'.html'});
      for(let i=0;i<50;i++){await pause(100);if(await evaluate(`document.readyState!=='loading' && location.pathname==='/${page}.html' && ${page==='pedidos'?"!!document.querySelector('.product-card')":"!!document.querySelector('main')"}`))break;}
      await check(page,width);
      if(page==='pedidos'){
        await evaluate("document.querySelector('#catalog [data-add]').click();document.querySelector('#catalog [data-add]').click();document.querySelector('#review-order').click();");
        await check('pagamento',width);
      }
      if(page==='painel'){
        await evaluate(`document.querySelector('#login-section').hidden=true;document.querySelector('#admin-content').hidden=false;document.querySelector('#orders-list').innerHTML='<article class="admin-order"><div><h3>#PEDIDO1234</h3><small>24/10/2026</small></div><div><strong>Nome comprido para conferir a quebra no celular</strong><small>3 itens · Entrega</small><span class="order-status">Aguardando confirmação</span></div><strong>R$ 123,90</strong><button class="btn btn-ghost">Ver pedido</button></article>';`);
        await check('painel-pedidos',width);
        await evaluate("document.querySelector('#catalog-section').hidden=false;document.querySelector('#orders-section').hidden=true;");
        await check('painel-configuracoes',width);
      }
    }
  }
  console.log(JSON.stringify(results,null,2));
  if(results.some(result=>result.issues.length))process.exitCode=1;
}finally{try{if(socket?.readyState===1){socket.send(JSON.stringify({id:99999,method:'Browser.close'}));await pause(200);}}catch{}socket?.close();chrome.kill();}
