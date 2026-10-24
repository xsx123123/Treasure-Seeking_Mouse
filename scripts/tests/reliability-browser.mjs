// Optional browser regression: see docs/ARC/reliability-fixes-2026-10-20.md.
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const staticServer=createServer((req,res)=>{let path=new URL(req.url,'http://local').pathname;if(path==='/'||!path.includes('.'))path='/index.html';try{const content=readFileSync((process.env.RELIABILITY_CLOUD_DIST || '/tmp/treasure-cloud-dist')+path);res.setHeader('Content-Type',path.endsWith('.js')?'application/javascript':path.endsWith('.css')?'text/css':path.endsWith('.html')?'text/html':'application/octet-stream');res.end(content);}catch{res.statusCode=404;res.end();}}).listen(19315,'127.0.0.1');
const browser=await chromium.launch({channel:'chromium',headless:true,args:['--no-sandbox']});const page=await browser.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const uid='00000000-0000-4000-8000-000000000001', exp=Math.floor(Date.now()/1000)+3600;
const jwt=[{alg:'HS256',typ:'JWT'},{sub:uid,exp,role:'authenticated'},'fixture'].map(x=>Buffer.from(typeof x==='string'?x:JSON.stringify(x)).toString('base64url')).join('.');
const user={id:uid,email:'cloud@example.test',app_metadata:{},user_metadata:{},aud:'authenticated',created_at:new Date().toISOString()};
await page.addInitScript(value=>{localStorage.setItem('sb-fixture-auth-token',JSON.stringify(value));},{access_token:jwt,refresh_token:'fixture',expires_at:exp,expires_in:3600,token_type:'bearer',user});
let sessions=[],messages=[];
await page.route('https://fixture.supabase.co/**',async route=>{
 const req=route.request(),url=new URL(req.url());const table=url.pathname.split('/').at(-1);let body;
 if(url.pathname.includes('/auth/'))body=user;
 else if(req.method()==='POST'){
  const row=req.postDataJSON();
  if(table==='chat_sessions'){body={id:'10000000-0000-4000-8000-000000000001',title:row.title,updated_at:new Date().toISOString()};sessions.push(body);}
  else if(table==='chat_messages'){messages.push(row);body={id:row.id};}
  else body={};
 }else if(table==='chat_sessions')body=sessions;
 else if(table==='chat_messages')body=messages;
 else body=[];
 await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
});
const cards=[{accession:'GSE90001',title:'Cloud card',summary:'',tool:'test',meta:{}}];
await page.route('http://127.0.0.1:18787/**',async route=>{
 if(route.request().method()==='GET'){await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({models:['fixture'],defaultModel:'fixture'})});return;}
 const events=[{delta:'Cloud answer.'},{event:'cards',cards},{event:'grounding',unconfirmed:[{id:'GSE999999',status:'unverified'}],confirmed:[]},{event:'polariseq',accession:null},{event:'end',cards,tools:[]}];
 await route.fulfill({status:200,contentType:'text/event-stream',body:events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+'data: [DONE]\n\n'});
});
try{
 await page.goto('http://127.0.0.1:19315/?lang=zh');await page.waitForSelector('textarea');await page.waitForTimeout(400);
 await page.locator('textarea').fill('cloud roundtrip');await page.locator('textarea').press('Enter');
 await page.waitForTimeout(1800);
 assert.equal(messages.length,2,JSON.stringify(messages));const assistant=messages.find(m=>m.role==='assistant');
 assert.equal(assistant.metadata.version,1);assert.equal(assistant.metadata.grounding.unconfirmed[0].id,'GSE999999');assert.equal(assistant.metadata.boost.accession,null);assert.equal(assistant.metadata.completion,'complete');
 await page.reload();await page.waitForSelector('textarea');await page.getByRole('button',{name:'展开会话列表',exact:true}).click();await page.getByRole('button',{name:'cloud roundtrip',exact:true}).click();
 await page.waitForSelector('text=Cloud answer.');
 assert.ok((await page.locator('body').innerText()).includes('下载加速 · Polariseq'));
console.log('GROUNDING_AND_BOOST_RESTORED');
await page.getByRole('button',{name:/编号|证实|核验/}).first().click();
assert.ok((await page.locator('body').innerText()).includes('GSE999999'));
 assert.equal(errors.length,0,errors.join('\n'));
 console.log('CLOUD_SERVICE_PAYLOAD_AND_RELOAD_GROUNDING_BOOST_PASSED; requests use intercepted Auth/REST fixtures, not production Supabase');
}finally{await browser.close();staticServer.close();}
