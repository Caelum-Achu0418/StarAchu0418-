(()=>{
  'use strict';

  const EXT_VERSION='2026.08.15-2';
  let ticking=false;
  let lastOutCount=-1;

  function ready(){
    return typeof state!=='undefined' && typeof getApiConfig==='function' && typeof currentSession==='function' && typeof buildSystemPrompt==='function' && typeof deliverReply==='function';
  }

  function defaults(){
    return {
      on:false,
      min:30,
      max:90,
      quietFrom:'00:30',
      quietTo:'08:00',
      dailyMax:6,
      count:0,
      day:'',
      lastUserAt:0,
      nextAt:0,
      lastSentAt:0
    };
  }

  function cfg(){
    if(!state.proactiveCfg || typeof state.proactiveCfg!=='object') state.proactiveCfg=defaults();
    state.proactiveCfg=Object.assign(defaults(),state.proactiveCfg);
    return state.proactiveCfg;
  }

  function dayKey(d=new Date()){
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function resetDay(){
    const c=cfg(),k=dayKey();
    if(c.day!==k){c.day=k;c.count=0;save();}
  }

  function clampNum(v,min,max,fallback){
    const n=Number(v);
    if(!Number.isFinite(n))return fallback;
    return Math.max(min,Math.min(max,n));
  }

  function randomDelayMs(){
    const c=cfg();
    const min=clampNum(c.min,1,1440,30);
    const max=Math.max(min,clampNum(c.max,1,1440,90));
    return (min+Math.random()*(max-min))*60000;
  }

  function scheduleFrom(base=Date.now()){
    const c=cfg();
    c.nextAt=base+randomDelayMs();
    save();
    renderStatus();
  }

  function hm(ts){
    if(!ts)return '未安排';
    try{return new Date(ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});}catch{return '已安排';}
  }

  function toMin(s){
    const p=String(s||'00:00').split(':').map(Number);
    return (p[0]||0)*60+(p[1]||0);
  }

  function quietInfo(now=new Date()){
    const c=cfg(),from=toMin(c.quietFrom),to=toMin(c.quietTo);
    if(from===to)return {inside:false,end:0};
    const cur=now.getHours()*60+now.getMinutes();
    const inside=from<to ? (cur>=from&&cur<to) : (cur>=from||cur<to);
    if(!inside)return {inside:false,end:0};
    const end=new Date(now);
    end.setSeconds(0,0);
    end.setHours(Math.floor(to/60),to%60,0,0);
    if(from>to && cur>=from)end.setDate(end.getDate()+1);
    return {inside:true,end:end.getTime()};
  }

  function latestUserSignal(){
    const sess=currentSession();
    const count=(sess&&Array.isArray(sess.messages))?sess.messages.filter(m=>m&&m.dir==='out').length:0;
    if(lastOutCount<0){lastOutCount=count;return 0;}
    if(count>lastOutCount){lastOutCount=count;return Date.now();}
    if(count<lastOutCount)lastOutCount=count;
    const fromApp=Number(state.lastUserTime)||0;
    const c=cfg();
    if(fromApp>Number(c.lastUserAt||0))return fromApp;
    return 0;
  }

  function noteUserActivity(ts){
    const c=cfg();
    c.lastUserAt=ts||Date.now();
    c.nextAt=c.lastUserAt+randomDelayMs();
    save();
    renderStatus();
  }

  function currentChar(){
    if(state.activeGroupId)return null;
    return Array.isArray(state.chars)?state.chars.find(x=>x.id===state.activeCharId):null;
  }

  function blocked(){
    try{
      if(typeof getBlock!=='function')return false;
      const b=getBlock();
      return !!(b&&(b.userBlocked||b.charBlocked));
    }catch{return false;}
  }

  function msgText(m,c){
    let content=m&&m.text||'';
    if(!m)return content;
    if(m.type==='emoji')content='[表情]';
    else if(m.type==='image')content='[图片]';
    else if(m.type==='imgdesc')content='[图片：'+(m.text||'')+']';
    else if(m.type==='voice')content='[语音]'+(m.text?'：'+m.text:'');
    else if(m.type==='transfer')content='['+(m.dir==='out'?'用户向你':'你向用户')+'转账 ￥'+(m.amount||'')+(m.note?'，'+m.note:'')+']';
    else if(m.type==='redpack')content='[红包：'+(m.note||'')+']';
    else if(m.type==='pay')content='[代付：'+(m.item||'')+' ￥'+(m.price||'')+']';
    else if(m.type==='forward')content='[转发记录]\n'+(m.lines||[]).map(l=>(l.who||'')+'：'+(l.text||'')).join('\n');
    if(m.quote)content='（引用：'+m.quote+'）\n'+content;
    if(state.activeGroupId&&m.senderName)content=m.senderName+'：'+content;
    return content;
  }

  async function generateProactive(isTest=false){
    const c=currentChar();
    if(!c)throw new Error('请先切到一个角色的私聊');
    if(blocked()&&!isTest)return {skip:true};
    const api=getApiConfig();
    if(!api.url||!api.model)throw new Error('接口还没有配置好');

    const sess=currentSession();
    const history=(sess.messages||[]).slice(-32).map(m=>({role:m.dir==='out'?'user':'assistant',content:msgText(m,c)}));
    const pc=cfg();
    const last=Number(pc.lastUserAt||state.lastUserTime||0);
    const gap=last?Math.max(1,Math.round((Date.now()-last)/60000)):0;
    const now=new Date();
    const extra=[
      '【主动联系模式】',
      '现在没有收到用户的新消息。你可以根据你的人设、关系、最近聊天和当前时间，决定是否主动联系用户。',
      gap?`距离用户上次主动发消息大约 ${gap} 分钟。`:'这是主动消息功能刚开始运行。',
      `当前本地时间：${now.toLocaleString()}。`,
      '如果此刻不适合打扰，只输出 [SKIP]。',
      '如果想联系，就直接输出你真正会发给用户的消息；自然、具体、有生活感，不要解释这是定时功能，也不要说“系统让我来找你”。',
      '尽量承接最近聊天，避免每次都用同一句问候。'
    ].join('\n');
    const system=buildSystemPrompt(c)+'\n\n'+extra;
    const tb=typeof tempBody==='function'?tempBody():{temperature:Number(state.temperature)||0.9,top_p:0.9};
    const typing=typeof addTyping==='function'?addTyping():null;
    try{
      const res=await fetch(api.url.replace(/\/+$/,'')+'/chat/completions',{
        method:'POST',
        headers:Object.assign({'Content-Type':'application/json'},api.key?{'Authorization':'Bearer '+api.key}:{}),
        body:JSON.stringify({
          model:api.model,
          temperature:tb.temperature,
          top_p:tb.top_p,
          messages:[{role:'system',content:system},...history,{role:'user',content:'请判断现在要不要主动找我。'}],
          stream:false
        })
      });
      if(!res.ok)throw new Error('HTTP '+res.status);
      const data=await res.json();
      const text=(data.choices&&data.choices[0]&&data.choices[0].message&&data.choices[0].message.content||'').trim();
      if(typing)typing.remove();
      if(!text||/^\s*\[SKIP\]\s*$/i.test(text))return {skip:true};
      await deliverReply(text,c,null);
      return {skip:false};
    }catch(e){
      if(typing)typing.remove();
      throw e;
    }
  }

  function afterSkip(){
    const c=cfg();
    const min=Math.max(10,Math.round(clampNum(c.min,1,1440,30)/2));
    const max=Math.max(min+5,Math.round(clampNum(c.max,1,1440,90)/2));
    c.nextAt=Date.now()+(min+Math.random()*(max-min))*60000;
    save();
  }

  async function tick(force=false){
    if(ticking||!ready())return;
    const pc=cfg();
    resetDay();
    const activity=latestUserSignal();
    if(activity)noteUserActivity(activity);
    if(!pc.on&&!force){renderStatus();return;}
    if(!currentChar()){renderStatus('先切到角色私聊');return;}
    if(!force&&pc.count>=clampNum(pc.dailyMax,1,50,6)){renderStatus('今天主动消息已到上限');return;}

    const qi=quietInfo();
    if(!force&&qi.inside){
      if(!pc.nextAt||pc.nextAt<qi.end)pc.nextAt=qi.end+(5+Math.random()*15)*60000;
      save();renderStatus('免打扰中');return;
    }

    if(!pc.nextAt){scheduleFrom(Date.now());return;}
    if(!force&&Date.now()<pc.nextAt){renderStatus();return;}

    ticking=true;
    renderStatus(force?'正在测试主动消息…':'正在想要不要来找你…');
    try{
      const result=await generateProactive(force);
      if(result.skip){
        afterSkip();
        renderStatus(force?'这次角色选择暂时不打扰':'这次决定先不打扰');
      }else{
        if(!force){pc.count=(pc.count||0)+1;pc.lastSentAt=Date.now();}
        scheduleFrom(Date.now());
        renderStatus(force?'测试消息已发送':'刚刚主动发了一条');
      }
    }catch(e){
      pc.nextAt=Date.now()+15*60000;
      save();
      renderStatus('主动消息失败：'+(e&&e.message?e.message:e));
    }finally{
      ticking=false;
      setTimeout(()=>renderStatus(),3500);
    }
  }

  function renderStatus(override){
    const el=document.getElementById('proactive-status');
    if(!el||!ready())return;
    const c=cfg();
    resetDay();
    if(override){el.textContent=override;return;}
    if(!c.on){el.textContent='已关闭。打开后，页面能运行时角色会在合适的时候自己来找你。';return;}
    const max=clampNum(c.dailyMax,1,50,6);
    el.textContent=`今天已主动 ${c.count||0}/${max} 次 · 下次候选时间 ${hm(c.nextAt)}`;
  }

  function mountUI(){
    if(document.getElementById('proactive-section'))return;
    const panel=document.getElementById('panel-settings');
    if(!panel)return;
    const dataHead=Array.from(panel.querySelectorAll('h3')).find(x=>x.textContent.trim()==='数据管理');
    if(!dataHead)return;
    const wrap=document.createElement('div');
    wrap.id='proactive-section';
    wrap.innerHTML=`
      <h3>主动消息</h3>
      <p class="hint">保留原来的 API 配置。网页能运行时，角色可在你没说话一段时间后自主决定要不要来找你。</p>
      <div class="row"><div><strong>允许主动来找我</strong><span class="desc">按随机间隔触发，角色也可以选择这次先不打扰</span></div><label class="switch"><input type="checkbox" id="proactive-on"><span class="slider-sw"></span></label></div>
      <div id="proactive-options">
        <div class="field" style="margin-top:14px"><label>没聊天多久后开始考虑（分钟）</label><div class="two"><input type="number" id="proactive-min" min="1" max="1440" placeholder="最短"><input type="number" id="proactive-max" min="1" max="1440" placeholder="最长"></div></div>
        <div class="field"><label>免打扰时间</label><div class="two"><input type="time" id="proactive-qfrom"><input type="time" id="proactive-qto"></div></div>
        <div class="field"><label>每天最多主动几次</label><input type="number" id="proactive-daily" min="1" max="50"></div>
        <div class="btn-group"><button class="btn btn-ghost" id="proactive-test">现在试一条主动消息</button></div>
        <p class="hint" id="proactive-status" style="margin-top:10px"></p>
      </div>`;
    panel.insertBefore(wrap,dataHead);

    const c=cfg();
    const on=document.getElementById('proactive-on');
    const min=document.getElementById('proactive-min');
    const max=document.getElementById('proactive-max');
    const qf=document.getElementById('proactive-qfrom');
    const qt=document.getElementById('proactive-qto');
    const daily=document.getElementById('proactive-daily');
    on.checked=!!c.on;min.value=c.min;max.value=c.max;qf.value=c.quietFrom;qt.value=c.quietTo;daily.value=c.dailyMax;

    on.addEventListener('change',()=>{
      c.on=on.checked;
      if(c.on){
        c.lastUserAt=Number(c.lastUserAt||state.lastUserTime||Date.now());
        scheduleFrom(Date.now());
      }else{save();renderStatus();}
    });
    function persist(){
      c.min=clampNum(min.value,1,1440,30);
      c.max=Math.max(c.min,clampNum(max.value,1,1440,90));
      c.quietFrom=qf.value||'00:30';
      c.quietTo=qt.value||'08:00';
      c.dailyMax=clampNum(daily.value,1,50,6);
      min.value=c.min;max.value=c.max;daily.value=c.dailyMax;
      if(c.on)scheduleFrom(Date.now());else save();
      renderStatus();
    }
    [min,max,qf,qt,daily].forEach(el=>el.addEventListener('change',persist));
    document.getElementById('proactive-test').addEventListener('click',()=>tick(true));
    renderStatus();
  }

  function init(){
    if(!ready()){setTimeout(init,250);return;}
    const c=cfg();
    resetDay();
    if(!c.lastUserAt)c.lastUserAt=Number(state.lastUserTime)||Date.now();
    if(c.on&&!c.nextAt)c.nextAt=Date.now()+randomDelayMs();
    save();
    mountUI();
    try{lastOutCount=(currentSession().messages||[]).filter(m=>m&&m.dir==='out').length;}catch{lastOutCount=0;}
    setInterval(()=>tick(false),30000);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)tick(false);});
    window.addEventListener('focus',()=>tick(false));
    renderStatus();
    console.info('[StarAchu proactive] loaded',EXT_VERSION);
  }

  if(document.readyState==='complete')setTimeout(init,350);
  else window.addEventListener('load',()=>setTimeout(init,350),{once:true});
})();
