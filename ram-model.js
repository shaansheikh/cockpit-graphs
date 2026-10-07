/* Build a device-sized RAM partition from process RSS and available memory. */
(function(root) {
  'use strict';
  function partition(mem, processes) {
    const total = Math.max(0, mem.total || 0);
    const free = Math.min(total, Math.max(0, mem.available || 0));
    const used = total-free;
    const resident = processes.reduce((sum, p)=>sum+Math.max(0,p.ram||0),0);
    // zram's compressed pages are real RAM that no process reports, so reserve
    // them before fitting process shares into what is left.
    const zram = Math.min(used, Math.max(0, mem.zramRam || 0));
    const budget = used-zram;
    const scale = resident>budget && resident>0 ? budget/resident : 1;
    const users = new Map();
    for(const p of processes) {
      if(!(p.ram>0))continue;
      if(!users.has(p.user))users.set(p.user,{key:`user:${p.user}`,name:p.user,value:0,processes:[],kind:'user'});
      const user=users.get(p.user),value=p.ram*scale;
      user.value+=value;
      user.processes.push({key:`process:${p.pid}`,name:p.name,pid:p.pid,user:p.user,rss:p.ram,value,kind:'process'});
    }
    const groups=[...users.values()].filter(g=>g.value>0).sort((a,b)=>b.value-a.value||a.name.localeCompare(b.name));
    for(const group of groups)group.processes.sort((a,b)=>b.value-a.value||a.pid-b.pid);
    const other=Math.max(0,budget-resident*scale);
    if(other>0)groups.push({key:'system',name:'System / other',value:other,kind:'system',processes:[]});
    if(zram>0)groups.push({key:'zram',name:'zram (compressed swap)',value:zram,kind:'zram',processes:[]});
    if(free>0)groups.push({key:'free',name:'Free',value:free,kind:'free',processes:[]});
    let angle=-Math.PI/2;
    for(const group of groups) {
      group.start=angle;group.end=angle+group.value/total*Math.PI*2;
      let position=group.start;
      for(const p of group.processes){p.start=position;p.end=position+p.value/total*Math.PI*2;position=p.end;}
      angle=group.end;
    }
    return {total,used,free,zram,resident,scale,groups};
  }
  if(typeof module!=='undefined'&&module.exports)module.exports={partition};
  else root.PiRam={partition};
})(typeof window!=='undefined'?window:globalThis);
