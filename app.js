'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const SCRIPT = '/usr/local/share/cockpit/pi-monitor/collector.py';
  const specs = {
    cpu: {percent:true, series:[['cpu','Active CPU','#5085ef'],['wait','Storage wait','#e4a44a']]},
    memory: {percent:true, series:[['memory','RAM','#9b7ce8'],['zram','zram swap','#28b5a1'],['diskSwap','SD swap','#e4a44a']]},
    disk: {series:[['diskRead','Read','#28b5a1'],['diskWrite','Write','#5085ef']]},
    network: {series:[['netIn','Received','#5085ef'],['netOut','Sent','#28b5a1']]}
  };
  let historical = [], livePoints = [], rows = [], current = null, range = 60, custom = null;
  let sort = 'ram', descending = true, allRows = false, liveProcess = null, historyProcess = null, generation = 0;
  let historyError = '', liveError = '', pending = '', retry = null, lastRender = 0;
  const bytes = (n, rate=false) => {
    if (!Number.isFinite(n)) return '—';
    const units=['B','KiB','MiB','GiB']; let unit=0;
    while(n>=1024 && unit<units.length-1){n/=1024;unit++;}
    return `${n.toFixed(n>=100 || unit===0?0:1)} ${units[unit]}${rate?'/s':''}`;
  };
  const percent = n => Number.isFinite(n) ? `${n.toFixed(1)}%` : '—';
  const MAX_CUSTOM = 14*86400000;
  // A preset follows "now"; a custom range is a fixed window.
  const timeWindow = () => custom || {start:Date.now()-range*60000, end:Date.now()};
  const timeLabel = (n, span=0) => new Date(n).toLocaleString([], span>26*3600000
    ? {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'} : {hour:'2-digit',minute:'2-digit'});
  const pointTime = n => new Date(n).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const hidden = () => document.hidden || cockpit.hidden;
  function error(){ $('error').hidden=!(historyError||liveError); $('error').textContent=[historyError,liveError].filter(Boolean).join(' '); }
  function points(){
    const {start:cutoff,end:limit}=timeWindow();
    const liveMinutes=new Set(livePoints.map(p=>Math.floor(p.time/60000)));
    return [...historical.filter(p=>!liveMinutes.has(Math.floor(p.time/60000))),...livePoints].filter(p=>p.time>=cutoff&&p.time<=limit).sort((a,b)=>a.time-b.time);
  }
  function drawChart(id, data){
    const host=$(`chart-${id}`), spec=specs[id], w=Math.max(250,host.clientWidth), h=210;
    const left=58,right=w-15,top=16,bottom=176,{start,end}=timeWindow(),span=end-start;
    const values=data.flatMap(p=>spec.series.map(s=>p[s[0]])).filter(Number.isFinite);
    const peak=spec.percent?100:Math.max(...values,1024)*1.18;
    const x=t=>left+(t-start)/(end-start)*(right-left), y=v=>bottom-v/peak*(bottom-top);
    let svg=`<svg viewBox="0 0 ${w} ${h}" aria-hidden="true"><defs>`;
    spec.series.forEach((s,i)=>{svg+=`<linearGradient id="fill-${id}-${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${s[2]}" stop-opacity=".15"/><stop offset="100%" stop-color="${s[2]}" stop-opacity=".015"/></linearGradient>`;});
    svg+='</defs>';
    for(let i=0;i<=4;i++){
      const v=peak*i/4, yy=y(v);
      svg+=`<line class="grid" x1="${left}" x2="${right}" y1="${yy}" y2="${yy}"/><text x="${left-9}" y="${yy+3}" text-anchor="end">${spec.percent?`${Math.round(v)}%`:bytes(v,true)}</text>`;
    }
    for(let i=0;i<=4;i++){
      const t=start+(end-start)*i/4;
      svg+=`<text x="${x(t)}" y="201" text-anchor="${i===0?'start':i===4?'end':'middle'}">${timeLabel(t,span)}</text>`;
    }
    spec.series.forEach((s,i)=>{
      let segments=[],segment=[],prior=null;
      for(const p of data){
        const gap=prior && p.time-prior.time>Math.max(180000,span/120);
        if(!Number.isFinite(p[s[0]])||gap){if(segment.length)segments.push(segment);segment=[];}
        if(Number.isFinite(p[s[0]]))segment.push([x(p.time),y(p[s[0]])]);
        prior=p;
      }
      if(segment.length)segments.push(segment);
      for(const seg of segments){
        const path=seg.map((p,j)=>`${j?'L':'M'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');
        svg+=`<path d="${path} L${seg[seg.length-1][0]},${bottom} L${seg[0][0]},${bottom} Z" fill="url(#fill-${id}-${i})"/><path class="series" d="${path}" stroke="${s[2]}"/>`;
      }
    });
    if(!data.length)svg+=`<text x="${(left+right)/2}" y="100" text-anchor="middle">Waiting for metric readings</text>`;
    svg+='<line class="cursor" stroke="var(--muted)" stroke-dasharray="3 3" visibility="hidden"/></svg><div class="tooltip" hidden></div>';
    host.innerHTML=svg;
    const tooltip=host.querySelector('.tooltip'), cursor=host.querySelector('.cursor');
    let selected=Math.max(0,data.length-1);
    function inspect(index){
      if(!data.length)return;
      selected=Math.max(0,Math.min(index,data.length-1));const p=data[selected],xx=x(p.time);
      tooltip.replaceChildren();const title=document.createElement('strong');title.textContent=pointTime(p.time);tooltip.append(title);
      for(const s of spec.series){const line=document.createElement('div'),label=document.createElement('span'),value=document.createElement('span');label.textContent=s[1];label.style.color=s[2];value.textContent=spec.percent?percent(p[s[0]]):bytes(p[s[0]],true);line.append(label,value);tooltip.append(line);}
      tooltip.hidden=false;tooltip.style.left=`${Math.max(0,Math.min(xx+12,w-tooltip.offsetWidth-4))}px`;
      cursor.setAttribute('x1',xx);cursor.setAttribute('x2',xx);cursor.setAttribute('y1',top);cursor.setAttribute('y2',bottom);cursor.setAttribute('visibility','visible');
      host.setAttribute('aria-label',`${id} at ${pointTime(p.time)}: ${spec.series.map(s=>`${s[1]} ${spec.percent?percent(p[s[0]]):bytes(p[s[0]],true)}`).join(', ')}`);
    }
    const nearest=t=>{let index=0;for(let i=1;i<data.length;i++)if(Math.abs(data[i].time-t)<Math.abs(data[index].time-t))index=i;return index;};
    function scrub(event){
      const xx=event.clientX-host.getBoundingClientRect().left,index=nearest(start+(xx-left)/(right-left)*(end-start));
      inspect(index);
      if(event.pointerType==='touch'&&data.length)pinned[id]=data[index].time;
    }
    function hide(){tooltip.hidden=true;cursor.setAttribute('visibility','hidden');}
    // Touch: keep receiving moves while the finger sweeps, and leave the readout up after lifting.
    host.onpointerdown=event=>{if(event.pointerType==='touch'){try{host.setPointerCapture(event.pointerId);}catch(exc){}}scrub(event);};
    host.onpointermove=scrub;
    host.onpointerleave=event=>{if(event&&event.pointerType==='touch')return;hide();};
    // Live samples redraw the chart every few seconds; restore a touch readout afterwards.
    if(pinned[id]!==undefined&&data.length)inspect(nearest(pinned[id]));
    host.onkeydown=event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();inspect(selected+(event.key==='ArrowRight'?1:-1));}};
    host.onblur=hide;
  }
  // Touch readouts stay up until the next tap, so remember them per chart across redraws.
  const pinned = {};
  document.addEventListener('pointerdown',event=>{
    for(const host of document.querySelectorAll('.chart')){
      if(host.contains(event.target))continue;
      delete pinned[host.id.replace('chart-','')];
      const tip=host.querySelector('.tooltip'),line=host.querySelector('.cursor');
      if(tip)tip.hidden=true;if(line)line.setAttribute('visibility','hidden');
    }
  });
  function renderCharts(){const data=points();for(const id of Object.keys(specs))drawChart(id,data);lastRender=Date.now();}
  let ramSelection=null;
  function renderRamDonut(p){
    const model=PiRam.partition(p.mem,rows),host=$('ram-donut'),legend=$('ram-users');
    const focusedKey=host.contains(document.activeElement)?document.activeElement.dataset.key:null;
    const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
    svg.setAttribute('viewBox','0 0 320 320');svg.setAttribute('role','group');
    svg.setAttribute('aria-label',`RAM usage: ${bytes(model.total)} total. Inner ring groups users, outer ring shows processes.`);
    const defs=document.createElementNS(ns,'defs'),hatch=document.createElementNS(ns,'pattern');
    hatch.setAttribute('id','zram-hatch');hatch.setAttribute('width','6');hatch.setAttribute('height','6');
    hatch.setAttribute('patternUnits','userSpaceOnUse');hatch.setAttribute('patternTransform','rotate(45)');
    const hatchBase=document.createElementNS(ns,'rect'),hatchLine=document.createElementNS(ns,'rect');
    hatchBase.setAttribute('width','6');hatchBase.setAttribute('height','6');hatchBase.style.fill='var(--ram-zram-base)';
    hatchLine.setAttribute('width','3');hatchLine.setAttribute('height','6');hatchLine.style.fill='var(--ram-zram)';
    hatch.append(hatchBase,hatchLine);defs.append(hatch);svg.append(defs);
    const elements=[];
    const hues={pi:219,scuttle:260,root:167,jellyfin:32};
    function hue(name){let hash=0;for(const c of name)hash=(hash*31+c.charCodeAt(0))>>>0;return hues[name]??hash%360;}
    function color(group,index=null){
      if(group.kind==='free')return 'var(--ram-free)';
      if(group.kind==='system')return 'var(--ram-system)';
      if(group.kind==='zram')return 'url(#zram-hatch)';
      return `hsl(${hue(group.name)} 66% ${index===null?59:46+(index%6)*6}%)`;
    }
    function arc(start,end,inner,outer){
      // An almost-full circle also handles a single-owner device.
      end=Math.min(end,start+Math.PI*2-0.000001);
      const point=(radius,angle)=>`${160+radius*Math.cos(angle)},${160+radius*Math.sin(angle)}`;
      const large=end-start>Math.PI?1:0;
      return `M${point(outer,start)} A${outer},${outer} 0 ${large} 1 ${point(outer,end)} L${point(inner,end)} A${inner},${inner} 0 ${large} 0 ${point(inner,start)} Z`;
    }
    function describe(item){
      $('ram-segment-name').textContent=item.kind==='process'?`${item.name} · PID ${item.pid}`:item.name;
      $('ram-segment-value').textContent=`${bytes(item.value)} · ${percent(item.value/model.total*100)}`;
      $('ram-segment-detail').textContent=item.kind==='process'?`User: ${item.user}. Resident memory: ${bytes(item.rss)}.${model.scale<1?' Chart share is scaled to fit used RAM.':''}`:
        item.kind==='free'?'Memory available for applications, including reclaimable cache.':
        item.kind==='system'?'Used RAM not attributed to the listed processes, including kernel memory.':
        item.kind==='zram'?'RAM holding compressed swapped-out pages. This is real, unreclaimable memory, but far smaller than the data it stores.':
        `${item.processes.length} processes. Their outer-ring segments align with this user’s share.`;
    }
    function select(item){
      ramSelection=item.key;describe(item);
      for(const e of elements)e.path.classList.toggle('selected',e.item.key===item.key || item.kind==='user'&&e.item.user===item.name);
    }
    function segment(item,group,inner,outer,fill){
      const path=document.createElementNS(ns,'path');
      path.setAttribute('d',arc(item.start,item.end,inner,outer));path.setAttribute('fill',fill);path.classList.add('ram-segment');
      path.setAttribute('tabindex','0');path.setAttribute('role','img');path.dataset.key=item.key;path.dataset.kind=item.kind;path.dataset.bytes=item.value;
      path.setAttribute('aria-label',`${item.kind==='process'?`${item.name}, PID ${item.pid}, user ${item.user}`:item.name}: ${bytes(item.value)}, ${percent(item.value/model.total*100)} of total RAM`);
      path.addEventListener('pointerenter',()=>select(item));path.addEventListener('focus',()=>select(item));path.addEventListener('click',()=>select(item));
      elements.push({item,path});svg.append(path);
    }
    legend.replaceChildren();
    for(const group of model.groups){
      const fill=color(group);segment(group,group,84,111,fill);
      if(group.processes.length)group.processes.forEach((item,i)=>segment(item,group,116,148,color(group,i)));
      else segment(group,group,116,148,fill);
      const line=document.createElement('button');line.className='ram-user';line.type='button';
      const dot=document.createElement('i');dot.style.background=group.kind==='zram'?'var(--ram-zram)':fill;
      const name=document.createElement('span');name.className='ram-user-name';name.textContent=group.name;
      const amount=document.createElement('span');amount.textContent=bytes(group.value);
      const share=document.createElement('small');share.textContent=percent(group.value/model.total*100);
      line.append(dot,name,amount,share);line.onclick=()=>select(group);legend.append(line);
    }
    function text(y,value,className){const el=document.createElementNS(ns,'text');el.setAttribute('x','160');el.setAttribute('y',y);el.setAttribute('text-anchor','middle');el.classList.add(className);el.textContent=value;svg.append(el);}
    text(144,'TOTAL RAM','ram-center-label');text(176,bytes(model.total),'ram-center-total');text(199,`${percent(model.used/model.total*100)} in use`,'ram-center-label');
    host.replaceChildren(svg);
    if(focusedKey){const focused=elements.find(e=>e.item.key===focusedKey);if(focused){focused.path.focus();select(focused.item);}}
    const selected=elements.find(e=>e.item.key===ramSelection);if(selected)select(selected.item);
    else{ramSelection=null;$('ram-segment-name').textContent='Explore your RAM';$('ram-segment-value').textContent=bytes(model.used)+' in use';$('ram-segment-detail').textContent='Hover over a ring segment, or focus it with your keyboard.';}
    $('ram-accounting').textContent=`Free includes reclaimable cache. Process shares use RSS, which can count shared pages more than once.${model.scale<1?' Shares are proportionally scaled to fit used RAM.':' Remaining used RAM is shown as System / other.'}`;
  }
  function renderSwap(m){
    const detail=$('swap-detail'),pressure=m.diskSwap>64*1048576;
    if(m.zramTotal){
      $('swap-now').textContent=`${bytes(m.zramUsed)} in zram`;
      const ratio=m.zramRam>0?` (${(m.zramUsed/m.zramRam).toFixed(1)}×)`:'';
      detail.textContent=`${bytes(m.zramRam)} RAM${ratio}`+(m.diskSwapTotal?` · SD swap ${bytes(m.diskSwap)}`:'');
    }else{
      $('swap-now').textContent=bytes(m.swap);
      detail.textContent=`${percent(m.swapTotal?m.swap/m.swapTotal*100:0)} of ${bytes(m.swapTotal)}`;
    }
    detail.classList.toggle('warn',pressure);
    detail.title=pressure?'Disk-backed swap is in use. This is slow and usually means real memory pressure.':'';
  }
  function renderSummary(p){
    $('cpu-now').textContent=percent(p.cpu);$('load-now').textContent=`Load ${p.load.toFixed(1)} · ${p.cores} cores · ${percent(p.wait)} storage wait`;
    $('ram-now').textContent=bytes(p.mem.used);$('ram-detail').textContent=`${percent(p.memory)} of ${bytes(p.mem.total)}`;
    $('available-now').textContent=bytes(p.mem.available);$('cache-detail').textContent=`${bytes(p.mem.cache)} buffers / cache`;
    renderSwap(p.mem);
    $('cpu-chart-value').textContent=percent(p.cpu);$('memory-chart-value').textContent=percent(p.memory);
    $('disk-chart-value').textContent=bytes(p.diskRead+p.diskWrite,true);$('network-chart-value').textContent=bytes(p.netIn+p.netOut,true);
  }
  function renderRows(){
    const query=$('filter').value.trim().toLowerCase();
    const filtered=rows.filter(p=>`${p.name} ${p.user} ${p.pid}`.toLowerCase().includes(query));
    filtered.sort((a,b)=>{const av=a[sort],bv=b[sort];const delta=typeof av==='string'?av.localeCompare(bv):(av??-1)-(bv??-1);return (descending?-delta:delta)||a.pid-b.pid;});
    const displayed=allRows?filtered:filtered.slice(0,15),body=$('processes');body.replaceChildren();
    for(const p of displayed){
      const tr=document.createElement('tr');
      for(const key of ['name','user','pid','cpu','ram']){
        const td=document.createElement('td');
        if(key==='cpu'||key==='ram')td.className='number';
        if(key==='ram'){
          const wrapper=document.createElement('div');wrapper.className='ram-cell';const track=document.createElement('span');track.className='ram-track';track.setAttribute('aria-hidden','true');const bar=document.createElement('i');bar.style.width=`${Math.min(100,p.ram/(current?.mem.total||1)*100)}%`;track.append(bar);const value=document.createElement('span');value.textContent=bytes(p.ram);wrapper.append(track,value);td.append(wrapper);
        }else td.textContent=key==='cpu'?percent(p.cpu):p[key];
        tr.append(td);
      }
      body.append(tr);
    }
    if(!displayed.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=5;td.className='empty';td.textContent=query?'No matching processes.':'Waiting for live processes…';tr.append(td);body.append(tr);}
    $('process-count').textContent=rows.length||'';$('rows-info').textContent=`Showing ${displayed.length} of ${filtered.length} processes`;
    $('show-all').hidden=filtered.length<=15;$('show-all').textContent=allRows?'Show fewer':'Show all';
    document.querySelectorAll('[data-sort]').forEach(button=>{const active=button.dataset.sort===sort;button.querySelector('span').textContent=active?(descending?'↓':'↑'):'';button.parentElement.setAttribute('aria-sort',active?(descending?'descending':'ascending'):'none');});
  }
  function loadHistory(){
    if(!custom&&!Number.isFinite(range))return;
    const ticket=++generation;if(historyProcess)historyProcess.close();
    $('history-status').textContent='Loading recorded history…';$('refresh').disabled=true;historyError='';error();
    historyProcess=cockpit.spawn(['python3',SCRIPT,...(custom?['history-range',String(Math.round(custom.start)),String(Math.round(custom.end))]:['history',String(range)])],{err:'message'});
    historyProcess.then(output=>{
      if(ticket!==generation)return;
      const result=JSON.parse(output);historical=result.points;
      $('history-status').textContent=historical.length?`PCP history · ${result.interval>=120?Math.round(result.interval/60)+' min':result.interval+'s'} resolution`:'No recorded history in this time range';renderCharts();
    }).catch(exc=>{if(ticket!==generation)return;historyError=`History unavailable. ${exc.message||exc}`;error();$('history-status').textContent='Showing live readings only';renderCharts();}).finally(()=>{if(ticket===generation){$('refresh').disabled=false;historyProcess=null;}});
  }
  function startLive(){
    if(liveProcess||hidden())return;
    pending='';liveError='';error();$('connection').textContent='Connecting…';$('connection').className='status';
    const process=cockpit.spawn(['python3','-u',SCRIPT,'live'],{err:'message'});liveProcess=process;
    process.stream(chunk=>{
      pending+=chunk;const lines=pending.split('\n');pending=lines.pop();
      for(const line of lines){if(!line.trim())continue;try{
        const p=JSON.parse(line);current=p;rows=p.processes;delete p.processes;livePoints.push(p);livePoints=livePoints.filter(point=>point.time>Date.now()-86400000);
        $('connection').textContent='Live';$('connection').className='status live';renderSummary(p);renderRamDonut(p);renderRows();renderCharts();
      }catch(exc){liveError=`Could not read a live sample: ${exc.message}`;error();}}
    });
    process.then(()=>finished(),exc=>finished(exc));
    function finished(exc){if(liveProcess!==process)return;liveProcess=null;$('connection').textContent='Disconnected';$('connection').className='status';if(exc){liveError=`Live readings unavailable. ${exc.message||exc}`;error();}if(!hidden())retry=setTimeout(startLive,10000);}
  }
  function stopLive(){clearTimeout(retry);if(liveProcess){const process=liveProcess;liveProcess=null;process.close();}$('connection').textContent='Paused';$('connection').className='status';}
  const localInput = ms => { const d=new Date(ms-new Date(ms).getTimezoneOffset()*60000); return d.toISOString().slice(0,16); };
  function showCustom(){
    const now=Date.now();
    $('custom-range').hidden=false;$('custom-error').textContent='';
    $('range-start').max=$('range-end').max=localInput(now);$('range-start').min=$('range-end').min=localInput(now-MAX_CUSTOM);
    if(!$('range-start').value||!$('range-end').value){$('range-start').value=localInput(custom?custom.start:now-86400000);$('range-end').value=localInput(custom?custom.end:now);}
  }
  $('range').onchange=()=>{
    if($('range').value==='custom'){showCustom();return;}
    custom=null;range=Number($('range').value);$('custom-range').hidden=true;historical=[];renderCharts();loadHistory();
  };
  $('custom-range').onsubmit=event=>{
    event.preventDefault();
    const start=new Date($('range-start').value).getTime(),end=new Date($('range-end').value).getTime(),fail=message=>{$('custom-error').textContent=message;};
    if(!Number.isFinite(start)||!Number.isFinite(end))return fail('Enter both a start and an end time.');
    if(end<=start)return fail('The end time must be after the start time.');
    if(end-start>MAX_CUSTOM)return fail('Choose a range of 14 days or less.');
    if(start>Date.now())return fail('The start time is in the future.');
    $('custom-error').textContent='';custom={start,end};historical=[];renderCharts();loadHistory();
  };
  $('refresh').onclick=loadHistory;$('filter').oninput=renderRows;$('show-all').onclick=()=>{allRows=!allRows;renderRows();};
  document.querySelectorAll('[data-sort]').forEach(button=>{button.onclick=()=>{if(sort===button.dataset.sort)descending=!descending;else{sort=button.dataset.sort;descending=['ram','cpu'].includes(sort);}renderRows();};});
  let resizeTimer;window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(renderCharts,100);});
  function visibilityChanged(){if(hidden())stopLive();else{startLive();if(Date.now()-lastRender>60000)loadHistory();}}
  document.addEventListener('visibilitychange',visibilityChanged);
  cockpit.addEventListener('visibilitychange',visibilityChanged);
  window.addEventListener('pagehide',()=>{stopLive();if(historyProcess)historyProcess.close();});
  renderCharts();loadHistory();startLive();
})();
