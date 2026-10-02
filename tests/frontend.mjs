import { parseHTML } from 'linkedom';
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const code=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const catalog=[{id:1,slug:'latte',name:'Latte',category:'coffee',description:'Smooth coffee',price_cents:450,is_available:true,product_styles:[{style:'Hot',extra_cents:0},{style:'Iced',extra_cents:50}]},
{id:2,slug:'chai',name:'Chai',category:'tea',description:'Spiced tea',price_cents:400,is_available:false,product_styles:[{style:'Hot',extra_cents:0}]}];
const settings={is_accepting_orders:true,testing_mode:true,lead_minutes:15};
async function fixture({missing=false}={}) {
  const {document,window}=parseHTML(html);
  window.Element.prototype.scrollIntoView=function(){};
  window.BG_PHOTOS={latte:'data:image/jpeg;base64,',tea:'data:image/jpeg;base64,',cold:'data:image/jpeg;base64,'};
  const state={session:null,role:false,requests:[],saved:[],failed:false,guestSignins:0};
  const client={
    from(table){const query={select(){return this},order(){return this},eq(){return this},single(){return this},in(){return this},limit(){return this},
      then(resolve,reject){return Promise.resolve(missing?{error:{message:'Missing table'}}:{data:table==='products'?catalog:table==='store_settings'?settings:state.saved,error:null}).then(resolve,reject)}};return query;},
    auth:{onAuthStateChange(){},async getSession(){return {data:{session:state.session}}},
      async signInAnonymously(){state.guestSignins++;state.session={user:{is_anonymous:true}};return {data:{session:state.session}}},
      async signInWithPassword(){state.session={user:{is_anonymous:false,email:'staff@example.com'}};state.role=true;return {}},
      async signOut(){state.session=null;state.role=false;return {}}},
    async rpc(name,args){
      if(name==='is_staff')return {data:state.role};
      if(name==='place_order'){
        state.requests.push(structuredClone(args));
        if(state.failed){state.failed=false;return {error:{message:'Network interrupted'}};}
        const row={id:'saved-order',order_number:1001,pickup_at:args.p_pickup_at,total_cents:900,is_test:true,customer_name:args.p_customer_name,status:'new',order_items:[{quantity:2,style:'Hot',product_name:'Latte'}]};
        state.saved=[row];return {data:row};
      }
      if(name==='staff_set_order_status'){state.saved[0].status=args.p_status;return {};}
      if(name==='staff_pause_orders'){settings.is_accepting_orders=!args.p_paused;return {};}
      return {};
    }
  };
  window.supabase={createClient(){return client}};
  vm.runInContext(code,vm.createContext({document,window,crypto:{randomUUID},Intl,Date,console,setInterval(){},setTimeout(fn){queueMicrotask(fn)}}));
  const flush=async()=>{for(let i=0;i<25;i++)await Promise.resolve();};
  const q=s=>document.querySelector(s);
  const click=async s=>{const b=q(s);assert.ok(b,`Missing ${s}`);b.dispatchEvent(new window.Event('click',{bubbles:true}));await flush();};
  await flush();
  // Linkedom doesn't auto-select the first option as browsers do.
  for(const select of document.querySelectorAll('select'))if(select.value===undefined && select.firstElementChild)select.firstElementChild.selected=true;
  return {document,window,state,q,click,flush};
}
let f=await fixture({missing:true});
assert.match(f.q('#bg-db-status').textContent,/not available/);
assert.equal(f.q('#bg-checkout').disabled,true);
assert.equal(f.state.requests.length,0);
f=await fixture();
assert.equal(f.document.querySelectorAll('.product').length,2);
assert.equal(f.q('[data-add="2"]').disabled,true,'Sold-out products cannot be ordered');
assert.match(f.q('#bg-db-status').textContent,/Test orders are saved/);
await f.click('[data-add="1"]');await f.click('[data-add="1"]');
assert.equal(f.q('#bg-total').textContent,'S$9.00');
await f.click('#bg-checkout');assert.match(f.q('#bg-confirm').textContent,/collection name/);
f.q('#bg-name').value='<img src=x onerror=alert(1)>';
f.state.failed=true;
await f.click('#bg-checkout');assert.match(f.q('#bg-confirm').textContent,/couldn’t confirm/);
assert.equal(f.q('#bg-cart-count').textContent,'2','Failed requests preserve the cart');
await f.click('#bg-checkout');assert.match(f.q('#bg-confirm').textContent,/BG-1001/);
assert.equal(f.state.requests[0].p_request_id,f.state.requests[1].p_request_id,'Retries reuse their idempotency key');
assert.equal(f.state.guestSignins,1);
assert.equal(f.q('#bg-cart-count').textContent,'0');
assert.deepEqual(f.state.requests[0].p_items,[{product_id:1,style:'Hot',quantity:2}],'Only IDs/options/quantity are submitted, not prices');
await f.click('[data-view="staff"]');assert.equal(f.q('#bg-login-panel').hidden,false);
f.q('#bg-email').value='staff@example.com';f.q('#bg-password').value='not-a-real-password';
f.q('#bg-login-form').dispatchEvent(new f.window.Event('submit',{bubbles:true,cancelable:true}));await f.flush();
assert.equal(f.q('#bg-staff-tools').hidden,false);
assert.equal(f.q('#bg-password').value,'','Password cleared after login');
assert.equal(f.q('#bg-new').querySelectorAll('.ticket').length,1);
assert.equal(f.q('#bg-new').querySelectorAll('img').length,0,'Customer names are rendered as text');
await f.click('[data-advance="saved-order"][data-status="preparing"]');
assert.equal(f.q('#bg-preparing').querySelectorAll('.ticket').length,1);
await f.click('#bg-signout');assert.equal(f.q('#bg-staff-tools').hidden,true);
assert.equal(f.q('#bg-new').textContent,'','Private data is removed on sign-out');
console.log('PASS: unavailable setup, sold-out menu, cart totals, validation, authenticated guest checkout, idempotent retries, saved receipt, staff sign-in, XSS-safe rendering, status changes and logout');
