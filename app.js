/* Black & Gold test ordering pilot. No secrets or privileged keys in this file. */
(() => {
  'use strict';
  const root = document.getElementById('bg-pitch');
  const q = s => root.querySelector(s);
  const money = cents => `S$${(cents / 100).toFixed(2)}`;
  const pickupLabel = value => new Intl.DateTimeFormat('en-SG', {
    timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'
  }).format(new Date(value));
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const previewMenu = [
    ['latte','Latte','coffee','Espresso with smooth, steamed milk.',450],
    ['cappuccino','Cappuccino','coffee','A classic cup with a soft layer of foam.',450],
    ['cold-brew','Cold Brew','coffee','Slow-brewed coffee, served chilled.',400],
    ['vanilla-chai','Vanilla Chai','tea','Warming spice and fragrant black tea.',400],
    ['russian-earl-grey','Russian Earl Grey','tea','Citrus notes with a fragrant tea finish.',400],
    ['hojicha-latte','Hojicha Latte','tea','Roasted tea with a mellow, milky finish.',500]
  ].map(([slug,name,category,description,price_cents],i)=>({id:i+1,slug,name,category,description,price_cents,is_available:true,
    product_styles:(slug==='cold-brew'?['Iced']:['Hot','Iced']).map(style=>({style,extra_cents:0}))}));
  let client, items = previewMenu, cart = [], settings = null, category = 'all';
  let storefrontReady = false, isStaff = false, staffBusy = false, submitting = false;
  let pendingRequest = null, view = 'customer', authCheck = 0;
  let orderGeneration = 0, historyGeneration = 0, historyPage = 0, historyCount = 0;
  const historyPageSize = 20;
  const message = (selector, text, error = false) => {
    const node = q(selector);
    node.textContent = text;
    node.classList.toggle('error', error);
    node.setAttribute('role', error ? 'alert' : 'status');
  };
  const safeError = (error, fallback) => {
    const text = error?.message || '';
    const allowed = /^(Ordering is paused|Choose a pickup|Choose between|Enter a collection|That pickup slot|Too many recent|The pilot order limit|The order queue|Each drink quantity|Please limit|A selected drink|A selected drink option|Live ordering|Pickup times|Combine duplicate|Order status changed|Staff access required|This checkout request)/;
    return allowed.test(text) ? text : fallback;
  };
  function invalidateCheckout() { pendingRequest = null; }
  function populateTimes() {
    const selected = q('#bg-time').value;
    const now = Date.now();
    const first = Math.ceil((now + (settings?.lead_minutes || 15) * 60000) / 900000) * 900000;
    q('#bg-time').replaceChildren();
    [0, 15, 30, 45, 60, 90, 120].forEach(offset => {
      const iso = new Date(first + offset * 60000).toISOString();
      const option = el('option', pickupLabel(iso));
      option.value = iso;
      option.selected = iso === selected;
      q('#bg-time').append(option);
    });
  }
  function renderProducts() {
    const selectedStyles = new Map([...root.querySelectorAll('[data-style]')].map(s => [s.dataset.style,s.value]));
    q('#bg-products').replaceChildren();
    items.filter(p => category === 'all' || p.category === category).forEach(p => {
      const card = el('article', undefined, 'product');
      const imageBox = el('div', undefined, 'product-photo');
      const image = el('img');
      image.loading = 'lazy';
      image.src = window.BG_PHOTOS[p.slug === 'cold-brew' ? 'cold' : p.category === 'tea' ? 'tea' : 'latte'];
      image.alt = 'Stock coffee and tea mood photograph';
      imageBox.append(image);
      const content = el('div', undefined, 'product-content');
      content.append(el('h3', p.name), el('p', p.description));
      const select = el('select');
      select.dataset.style = String(p.id);
      select.setAttribute('aria-label', `${p.name} style`);
      p.product_styles.forEach(s => {
        const opt = el('option', s.style + (s.extra_cents ? ` (+${money(s.extra_cents)})` : ''));
        opt.value = s.style;
        opt.selected = selectedStyles.get(String(p.id)) === s.style;
        select.append(opt);
      });
      const row = el('div', undefined, 'row');
      const price = el('span', money(p.price_cents));
      const add = el('button', p.is_available ? 'Add +' : 'Sold out', 'add');
      add.type = 'button'; add.dataset.add = String(p.id);
      add.disabled = !p.is_available || !storefrontReady || !settings?.is_accepting_orders || submitting;
      const updatePrice = () => {
        const style = p.product_styles.find(s => s.style === select.value);
        price.textContent = money(p.price_cents + (style?.extra_cents || 0));
      };
      select.addEventListener('change', updatePrice);
      updatePrice(); row.append(price, add); content.append(select, row); card.append(imageBox, content);
      q('#bg-products').append(card);
    });
  }
  function renderCart() {
    const target = q('#bg-cart'); target.replaceChildren();
    if (!cart.length) target.append(el('p', 'Your next favourite cup starts here.', 'muted cart-empty'));
    cart.forEach((line, index) => {
      const row = el('div', undefined, 'cart-row');
      const text = el('span');
      text.append(el('div', `${line.quantity} × ${line.style} ${line.name}`), el('div', money(line.unit_cents * line.quantity)));
      const remove = el('button', '×'); remove.type = 'button'; remove.dataset.remove = String(index);
      remove.setAttribute('aria-label', `Remove ${line.name}`); remove.disabled = submitting;
      row.append(text, remove); target.append(row);
    });
    q('#bg-total').textContent = money(cart.reduce((total,line) => total+line.quantity*line.unit_cents,0));
    q('#bg-cart-count').textContent = cart.reduce((n,line) => n+line.quantity,0);
    q('#bg-checkout').disabled = submitting || !storefrontReady || !settings?.is_accepting_orders || !cart.length;
    q('#bg-checkout').textContent = submitting ? 'Saving your test order…' : 'Place test order ↗';
  }
  async function loadStorefront() {
    if (!client) return;
    try {
      const [catalog, store] = await Promise.all([
        client.from('products').select('id,slug,name,category,description,price_cents,is_available,product_styles(style,extra_cents)').order('sort_order'),
        client.from('store_settings').select('is_accepting_orders,testing_mode,lead_minutes').eq('id',true).single()
      ]);
      if (catalog.error || store.error || !catalog.data?.length) throw catalog.error || store.error || new Error('Menu missing');
      items = catalog.data.map(p => ({...p,product_styles:[...p.product_styles].sort((a,b) => a.style.localeCompare(b.style))}));
      settings = store.data; storefrontReady = Boolean(settings.testing_mode);
      q('#bg-products').removeAttribute('aria-busy');
      message('#bg-db-status', !settings.testing_mode ? 'Ordering is not available yet.' : settings.is_accepting_orders ? 'Test orders are saved. No drinks will be prepared.' : 'Ordering is paused. Please check back shortly.');
      q('#bg-pause').textContent = settings.is_accepting_orders ? 'Pause orders' : 'Resume orders';
      populateTimes(); renderProducts(); renderCart();
      return true;
    } catch (error) {
      storefrontReady = false; message('#bg-db-status','Ordering is not available yet. Please check back shortly.',true);
      q('#bg-products').removeAttribute('aria-busy');
      if (!items.length) q('#bg-products').replaceChildren(el('p','Our online menu is getting ready.','muted'));
      renderCart(); return false;
    }
  }
  async function submitOrder() {
    if (submitting || !storefrontReady || !cart.length) return;
    const name = q('#bg-name').value.trim();
    if (!name || name.length>40 || /[\x00-\x1f\x7f]/.test(name)) {
      message('#bg-confirm','Enter a collection name (1–40 characters).',true); q('#bg-name').focus(); return;
    }
    const pickup = q('#bg-time').value;
    if (!pickup || new Date(pickup).getTime() < Date.now() + (settings.lead_minutes * 60000)-60000) {
      populateTimes(); invalidateCheckout(); message('#bg-confirm','Choose a new pickup time before ordering.',true); return;
    }
    const payload = {p_customer_name:name,p_pickup_at:pickup,p_items:cart.map(line => ({product_id:line.id,style:line.style,quantity:line.quantity}))};
    const fingerprint = JSON.stringify(payload);
    if (!pendingRequest || pendingRequest.fingerprint !== fingerprint) pendingRequest = {fingerprint,id:crypto.randomUUID()};
    payload.p_request_id = pendingRequest.id;
    submitting = true; renderCart(); renderProducts(); message('#bg-confirm','');
    q('#bg-name').disabled = true; q('#bg-time').disabled = true;
    try {
      const {data:sessionData,error:sessionError} = await client.auth.getSession();
      if (sessionError) throw sessionError;
      if (!sessionData.session) {
        const {error} = await client.auth.signInAnonymously();
        if (error) {
          message('#bg-confirm','Guest ordering is not available yet. Please try again later.',true); return;
        }
      }
      const {data,error} = await client.rpc('place_order',payload);
      if (error) throw error;
      if (!data?.id || !data?.order_number) throw new Error('No order confirmation');
      cart = []; pendingRequest = null;
      const receipt = el('div',undefined,'receipt');
      receipt.append(el('span','✓','success-mark'),el('h3',`Test order BG-${data.order_number}`),
        el('div',pickupLabel(data.pickup_at)),el('div',`Sample total ${money(data.total_cents)}`),
        el('p','Saved to our order desk. This is a test; no payment or drink preparation.','muted'));
      q('#bg-confirm').replaceChildren(receipt); q('#bg-confirm').classList.remove('error');
      q('#bg-confirm').setAttribute('role','status');
      if (isStaff) await refreshOrders();
    } catch (error) {
      message('#bg-confirm',safeError(error,'We couldn’t confirm your order. Retry with the same details to avoid a duplicate.'),true);
    } finally {
      submitting = false; q('#bg-name').disabled = false; q('#bg-time').disabled = false;
      renderProducts(); renderCart();
    }
  }
  function switchView(next) {
    view = next;
    root.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed',button.dataset.view === next));
    q('#bg-customer').hidden = next !== 'customer'; q('#bg-staff').hidden = next !== 'staff';
    if (next === 'staff') checkStaff();
  }
  function clearStaff() {
    orderGeneration++; historyGeneration++; staffBusy = false;
    isStaff = false; q('#bg-staff-tools').hidden = true; q('#bg-login-panel').hidden = false;
    ['new','preparing','ready'].forEach(status => q('#bg-'+status).replaceChildren());
    q('#bg-inventory').replaceChildren();
    q('#bg-history-body').replaceChildren();
    message('#bg-history-message','');
    historyPage=0; historyCount=0;
  }
  async function checkStaff() {
    if (!client) return;
    const check = ++authCheck;
    try {
      const {data:sessionData,error} = await client.auth.getSession();
      if (check !== authCheck) return;
      if (error || !sessionData.session || sessionData.session.user.is_anonymous) {clearStaff(); return;}
      const {data:allowed,error:roleError} = await client.rpc('is_staff');
      if (check !== authCheck) return;
      if (roleError || allowed !== true) {
        clearStaff(); message('#bg-login-message','This account does not have staff access. Ask the project owner to approve it.',true); return;
      }
      isStaff = true; q('#bg-login-panel').hidden = true; q('#bg-staff-tools').hidden = false;
      q('#bg-staff-email').textContent = sessionData.session.user.email;
      if (view === 'staff') {await loadStorefront(); renderInventory(); await refreshOrders();}
    } catch {clearStaff(); message('#bg-login-message','Staff sign-in is unavailable. Please try again.',true);}
  }
  async function login(event) {
    event.preventDefault(); const button=q('#bg-signin'); button.disabled=true;
    message('#bg-login-message','Signing in…');
    try {
      if (!client) throw new Error('Connection unavailable');
      const {error} = await client.auth.signInWithPassword({email:q('#bg-email').value.trim(),password:q('#bg-password').value});
      if (error) throw error;
      q('#bg-password').value=''; message('#bg-login-message',''); await checkStaff();
    } catch {message('#bg-login-message','Sign-in failed. Check your email and password and try again.',true);}
    finally {button.disabled=false;}
  }
  async function refreshOrders() {
    if (!client || !isStaff || staffBusy) return;
    staffBusy = true;
    const generation = ++orderGeneration;
    try {
      const {data:allowed,error:accessError}=await client.rpc('is_staff');
      if (!isStaff || generation !== orderGeneration) return;
      if (accessError || allowed!==true) {clearStaff(); return;}
      const {data,error} = await client.from('orders')
        .select('id,order_number,customer_name,pickup_at,total_cents,status,is_test,order_items(product_name,style,quantity)')
        .in('status',['new','preparing','ready']).order('pickup_at').limit(200);
      if(error) throw error;
      if (!isStaff || generation !== orderGeneration) return;
      ['new','preparing','ready'].forEach(status => {
        const lane=q('#bg-'+status); lane.replaceChildren();
        const orders=data.filter(order=>order.status===status);
        if (!orders.length) lane.append(el('p','No orders here.','muted'));
        orders.forEach(order => {
          const card=el('article',undefined,'ticket');
          card.append(el('strong',`BG-${order.order_number} · ${order.customer_name}`));
          order.order_items.forEach(line=>card.append(el('div',`${line.quantity} × ${line.style} ${line.product_name}`)));
          card.append(el('div',pickupLabel(order.pickup_at)),el('div',money(order.total_cents)),el('small',order.is_test?'Test order · no payment':'Pay at collection','muted'));
          const next=status==='new'?'preparing':status==='preparing'?'ready':'collected';
          const advance=el('button',status==='new'?'Accept & prepare':status==='preparing'?'Mark ready':order.is_test?'Complete test order':'Mark paid & collected','gold');
          advance.type='button'; advance.dataset.advance=order.id; advance.dataset.status=next;
          const cancel=el('button','Cancel order','staff-secondary');
          cancel.type='button'; cancel.dataset.advance=order.id; cancel.dataset.status='cancelled';
          card.append(advance,cancel); lane.append(card);
        });
      });
      message('#bg-staff-message',`Updated ${new Intl.DateTimeFormat('en-SG',{timeZone:'Asia/Singapore',hour:'numeric',minute:'2-digit',second:'2-digit'}).format(new Date())} · refreshes every 10 seconds`);
      await refreshHistory();
    } catch {if(isStaff && generation===orderGeneration)message('#bg-staff-message','Couldn’t refresh orders. Your last view may be out of date.',true);}
    finally {if(generation===orderGeneration)staffBusy=false;}
  }
  async function refreshHistory() {
    if (!client || !isStaff) return;
    const generation=++historyGeneration;
    q('#bg-history').setAttribute('aria-busy','true');
    q('#bg-history-prev').disabled=true; q('#bg-history-next').disabled=true;
    try {
      const {data:allowed,error:accessError}=await client.rpc('is_staff');
      if (!isStaff || generation!==historyGeneration) return;
      if (accessError || allowed!==true) {clearStaff(); return;}
      let query=client.from('orders').select('id,order_number,customer_name,created_at,pickup_at,total_cents,status,is_test,order_items(product_name,style,quantity)',{count:'exact'})
        .order('created_at',{ascending:false}).order('order_number',{ascending:false});
      const status=q('#bg-history-status').value;
      if (status && status!=='all') query=query.eq('status',status);
      const date=q('#bg-history-date').value;
      if (date) {
        const start=new Date(`${date}T00:00:00+08:00`);
        if (!Number.isFinite(start.getTime())) throw new Error('Invalid date');
        query=query.gte('created_at',start.toISOString()).lt('created_at',new Date(start.getTime()+86400000).toISOString());
      }
      const {data,count,error}=await query.range(historyPage*historyPageSize,(historyPage+1)*historyPageSize-1);
      if (!isStaff || generation!==historyGeneration) return;
      if(error) throw error;
      historyCount=count??data.length;
      if(historyPage>0 && !data.length) {historyPage=Math.max(0,Math.ceil(historyCount/historyPageSize)-1);await refreshHistory();return;}
      const body=q('#bg-history-body');body.replaceChildren();
      const labels={new:'New',preparing:'Preparing',ready:'Ready',collected:'Collected',cancelled:'Cancelled'};
      data.forEach(order=>{
        const row=el('tr');
        const cell=(label)=>{const td=el('td');td.dataset.label=label;row.append(td);return td;};
        const ref=cell('Order');ref.append(el('strong',`BG-${order.order_number}`),el('div',pickupLabel(order.created_at),'muted'));
        if(order.is_test)ref.append(el('small','Test order','history-test'));
        cell('Customer').append(el('span',order.customer_name));
        const drinks=cell('Drinks');drinks.className='history-drinks';
        order.order_items.forEach(line=>drinks.append(el('div',`${line.quantity} × ${line.style} ${line.product_name}`)));
        cell('Pickup').textContent=pickupLabel(order.pickup_at);
        const total=cell('Total');total.textContent=money(order.total_cents);total.className='history-total';
        const badge=el('span',labels[order.status]||order.status,'history-status');badge.dataset.status=order.status;cell('Status').append(badge);
        body.append(row);
      });
      message('#bg-history-message',historyCount?`${historyPage*historyPageSize+1}–${Math.min((historyPage+1)*historyPageSize,historyCount)} of ${historyCount} orders · newest first`:'No orders match these filters.');
      q('#bg-history-prev').disabled=historyPage===0;
      q('#bg-history-next').disabled=(historyPage+1)*historyPageSize>=historyCount;
    }catch {
      if(isStaff && generation===historyGeneration){
        q('#bg-history-body').replaceChildren();
        message('#bg-history-message','Couldn’t load order history. Click Refresh to try again.',true);
      }
    }finally {if(generation===historyGeneration)q('#bg-history').setAttribute('aria-busy','false');}
  }
  async function setStatus(button) {
    if (!isStaff || button.disabled) return;
    button.disabled = true;
    const {error} = await client.rpc('staff_set_order_status',{p_order_id:button.dataset.advance,p_status:button.dataset.status});
    if(error) {message('#bg-staff-message',safeError(error,'Couldn’t update this order. Refresh and try again.'),true);button.disabled=false;}
    else await refreshOrders();
  }
  function renderInventory() {
    q('#bg-inventory').replaceChildren();
    items.forEach(p => {
      const row=el('form',undefined,'inventory-row'); row.dataset.product=String(p.id);
      const label=el('label',p.name,'inventory-name');
      const price=el('input'); price.type='number'; price.min='0.50';price.max='1000';price.step='0.01';price.required=true;price.value=(p.price_cents/100).toFixed(2);
      price.setAttribute('aria-label',`${p.name} price in SGD`); price.dataset.price='';
      const availability=el('select'); availability.setAttribute('aria-label',`${p.name} availability`);availability.dataset.available='';
      ['Available','Sold out'].forEach((text,i)=>{const option=el('option',text);option.value=i===0?'true':'false';option.selected=(i===0)===p.is_available;availability.append(option);});
      const button=el('button','Save','staff-secondary');button.type='submit';
      row.append(label,price,availability,button);
      row.addEventListener('submit',async event=>{
        event.preventDefault();button.disabled=true;
        const cents=Math.round(Number(price.value)*100);
        const {error}=await client.rpc('staff_set_product',{p_product_id:p.id,p_available:availability.value==='true',p_price_cents:cents});
        if(error) message('#bg-inventory-message','Couldn’t save this drink. Check the price and try again.',true);
        else {await loadStorefront();message('#bg-inventory-message',`${p.name} saved.`);}
        button.disabled=false;
      });
      q('#bg-inventory').append(row);
    });
  }
  root.addEventListener('click',async event=>{
    const b=event.target.closest('button'); if(!b || b.disabled) return;
    if(b.dataset.view) switchView(b.dataset.view);
    if(['bg-menu-link','bg-order','bg-bag'].includes(b.id)) {
      switchView('customer'); (b.id==='bg-bag'?q('.basket'):q('#bg-menu-title')).scrollIntoView({behavior:'smooth',block:'start'});
    }
    if(b.dataset.category) {
      category=b.dataset.category; root.querySelectorAll('[data-category]').forEach(x=>x.setAttribute('aria-pressed',x===b));renderProducts();
    }
    if(b.dataset.add && !submitting) {
      const p=items.find(x=>String(x.id)===b.dataset.add); if(!p?.is_available)return;
      const style=q(`[data-style="${p.id}"]`).value;
      const option=p.product_styles.find(x=>x.style===style);if(!option)return;
      const existing=cart.find(line=>line.id===p.id && line.style===style);
      if(cart.reduce((n,line)=>n+line.quantity,0)>=20 || existing?.quantity>=10) {
        message('#bg-confirm','Please limit each order to 20 drinks and each selection to 10.',true);return;
      }
      if(existing)existing.quantity++;else cart.push({id:p.id,name:p.name,style,quantity:1,unit_cents:p.price_cents+option.extra_cents});
      invalidateCheckout();message('#bg-confirm','');renderCart();
    }
    if(b.dataset.remove!==undefined && !submitting) {cart.splice(Number(b.dataset.remove),1);invalidateCheckout();renderCart();}
    if(b.id==='bg-checkout') await submitOrder();
    if(b.id==='bg-refresh') {await loadStorefront();renderInventory();await refreshOrders();}
    if(b.id==='bg-signout') {await client.auth.signOut();clearStaff();q('#bg-password').value='';message('#bg-login-message','Signed out.');}
    if(b.dataset.advance) await setStatus(b);
    if(b.id==='bg-history-prev') {historyPage=Math.max(0,historyPage-1);await refreshHistory();}
    if(b.id==='bg-history-next') {historyPage++;await refreshHistory();}
    if(b.id==='bg-pause') {
      b.disabled=true;
      try {
        const {error}=await client.rpc('staff_pause_orders',{p_paused:Boolean(settings?.is_accepting_orders)});
        if(error)throw error;
        await loadStorefront();message('#bg-staff-message',settings.is_accepting_orders?'Ordering resumed.':'Ordering paused.');
      }catch {message('#bg-staff-message','Couldn’t change ordering availability.',true);}finally{b.disabled=false;}
    }
  });
  q('#bg-login-form').addEventListener('submit',login);
  ['#bg-history-status','#bg-history-date'].forEach(selector=>q(selector).addEventListener('change',()=>{historyPage=0;refreshHistory();}));
  q('#bg-name').addEventListener('input',invalidateCheckout);
  q('#bg-time').addEventListener('change',invalidateCheckout);
  renderProducts(); renderCart();
  if (!window.supabase?.createClient) {
    message('#bg-db-status','Ordering could not connect. Please reload and try again.',true);return;
  }
  client=window.supabase.createClient('https://tnjfmkkdxwbiaioxvxhu.supabase.co','sb_publishable_CEmKgW-GKifAZ7OYCPaJOw_9cGihQ6Y',{
    auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}
  });
  client.auth.onAuthStateChange(()=>setTimeout(()=>checkStaff(),0));
  loadStorefront();
  setInterval(()=>{if(view==='staff' && isStaff && document.visibilityState!=='hidden')refreshOrders();},10000);
  setInterval(()=>{if(!submitting && document.visibilityState!=='hidden')loadStorefront();},60000);
})();
