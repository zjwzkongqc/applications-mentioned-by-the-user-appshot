const Growth=(()=>{
  const projects=[['forehand','正手'],['backhand','反手'],['serve','发球'],['return_skill','接发球'],['net','网前截击'],['footwork','移动与回位'],['fitness','体能'],['match','实战'],['other','其他']];
  const effects=[['improved','明显进步'],['some','有所改善'],['practice','还需练习'],['exploring','先找感觉']];
  const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const model={data:null,error:null,month:null,page:0,metric:'total',club:null};
  const projectKeys=r=>{try{const p=JSON.parse(r?.training_projects||'[]');return Array.isArray(p)?p:[];}catch{return [];}};
  const projectName=k=>projects.find(p=>p[0]===k)?.[1]||k;
  const effectName=k=>effects.find(p=>p[0]===k)?.[1]||'';
  async function load(){
    if(model.club!==state.board.club.id){reset();model.club=state.board.club.id;}
    try{
      const query=new URLSearchParams({page:String(model.page)});if(model.month)query.set('month',model.month);
      model.data=await request(`/api/growth?${query}`);
      const lastPage=Math.max(0,Math.ceil(model.data.summary.records/20)-1);
      if(model.page>lastPage){model.page=lastPage;query.set('page',String(lastPage));model.data=await request(`/api/growth?${query}`);}
      model.month=model.data.month;model.error=null;
    }catch(err){model.error=err.message;}
  }
  function reset(){Object.assign(model,{data:null,error:null,month:null,page:0,metric:'total',club:null});}
  function checkinBar(){
    const b=state.board,checked=b.todayCheckins?.includes(b.me),count=b.todayCheckins?.length||0;
    return `<section class="checkin-bar"><div><p class="eyebrow">SHOW UP, GROW A LITTLE</p><h2>${checked?'今天的坚持，已经记下。':'今天，也为网球留一点时间。'}</h2><p>${count} 位搭子今日已签到 · 签到按北京时间记录</p></div><div class="checkin-actions"><button class="${checked?'secondary':'primary lime'}" data-action="checkin" ${checked?'disabled':''}>${checked?'✓ 今日已签到':'今日签到'}</button><button class="text-button" data-action="tab" data-tab="my">查看成长档案</button></div></section>`;
  }
  function form(record,enabled=false){
    const p=projectKeys(record),active=enabled||p.length>0,last=model.data?.nextPlan;
    return `<section class="training-form"><label class="training-toggle" for="enable-training"><span><strong>记录这次训练</strong><small>今天练什么、效果怎样、下次继续什么</small></span><input id="enable-training" type="checkbox" ${active?'checked':''} aria-controls="training-fields"></label><div id="training-fields" ${active?'':'hidden'}>${last&&!record?`<div class="last-plan"><strong>上次说下次要练</strong><p>${e(last.next_plan)}</p><button type="button" class="text-button" data-action="use-training-plan">带入今天的练习</button></div>`:''}<fieldset class="training-projects"><legend>今天训练了什么项目？ <span class="optional">可多选</span></legend><div>${projects.map(([k,n])=>`<label><input type="checkbox" name="training_project" value="${k}" ${p.includes(k)?'checked':''} ${active?'':'disabled'}><span>${n}</span></label>`).join('')}</div></fieldset><div class="training-field"><label for="training-content">具体练了什么 <span class="optional">选填</span></label><textarea id="training-content" name="training_content" maxlength="1000" placeholder="比如：练了 30 次二发，重点找抛球位置和落点。" ${active?'':'disabled'}>${e(record?.training_content||'')}</textarea></div><div class="training-field"><label for="training-effect">训练效果如何？ <span class="optional">可以练完再补</span></label><select id="training-effect" name="training_effect" ${active?'':'disabled'}><option value="">还没复盘</option>${effects.map(([k,n])=>`<option value="${k}" ${record?.training_effect===k?'selected':''}>${n}</option>`).join('')}</select></div><div class="training-field"><label for="effect-note">效果与发现 <span class="optional">选填</span></label><textarea id="effect-note" name="effect_note" maxlength="500" placeholder="比如：10 次发球进了 7 次；抛球低时还是容易下网。" ${active?'':'disabled'}>${e(record?.effect_note||'')}</textarea></div><div class="training-field"><label for="next-plan">下一次准备训练什么？ <span class="optional">选填</span></label><textarea id="next-plan" name="next_plan" maxlength="500" placeholder="给下次留一个小目标，比如：继续练二发，争取 10 次进 8 次。" ${active?'':'disabled'}>${e(record?.next_plan||'')}</textarea></div><p class="training-save-note">保存今天的训练会同时完成今日签到；补录历史训练也会进入成长档案。</p></div></section>`;
  }
  function bindForm(form){const toggle=form.querySelector('#enable-training'),fields=form.querySelector('#training-fields');toggle.addEventListener('change',()=>{fields.hidden=!toggle.checked;fields.querySelectorAll('input,textarea,select').forEach(x=>x.disabled=!toggle.checked);});}
  function readTraining(form){
    if(!form.querySelector('#enable-training').checked)return null;
    const picked=[...form.querySelectorAll('input[name=training_project]:checked')].map(x=>x.value);
    if(!picked.length)throw new Error('先选一个今天训练的项目吧。');
    return {projects:picked,content:form.querySelector('#training-content').value,effect:form.querySelector('#training-effect').value,effectNote:form.querySelector('#effect-note').value,nextPlan:form.querySelector('#next-plan').value};
  }
  function recordDetails(r){
    const p=projectKeys(r);if(!p.length)return '';
    return `<section class="training-details"><div class="training-tags">${p.map(k=>`<span>${e(projectName(k))}</span>`).join('')}<span class="effect-tag ${r.training_effect?'':'pending'}">${effectName(r.training_effect)||'效果待复盘'}</span></div><dl><dt>今天练了</dt><dd>${e(r.training_content||p.map(projectName).join('、'))}</dd>${r.effect_note?`<dt>效果与发现</dt><dd>${e(r.effect_note)}</dd>`:''}${r.next_plan?`<dt>下次准备</dt><dd>${e(r.next_plan)}</dd>`:''}</dl></section>`;
  }
  function summary(){const s=model.data.summary;return `<div class="growth-stats">${[['累计签到',s.checkin_days,'天'],['连续签到',s.streak,'天'],['训练记录',s.training_sessions,'次'],['累计训练',hours(s.training_minutes),'小时']].map(([label,value,unit])=>`<div><span>${label}</span><strong>${value}<small>${unit}</small></strong></div>`).join('')}</div>`;}
  function nextPlan(){const p=model.data.nextPlan;return `<section class="next-training-plan"><div><p class="eyebrow">NEXT TIME ON COURT</p><h2>下一次，接着练。</h2>${p?`<p class="plan-content">${e(p.next_plan)}</p><small>来自 ${e(p.play_date)} 的训练复盘</small>`:'<p class="plan-content">给下一场留一个小目标。先把一个动作练顺，也是一种进步。</p>'}</div><button class="primary" data-action="training">${p?'开始这次训练记录':'定下训练小目标'}</button></section>`;}
  function shiftMonth(month,delta){const [y,m]=month.split('-').map(Number),d=new Date(Date.UTC(y,m-1+delta,1));return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;}
  function calendar(){
    const d=model.data,[y,m]=d.month.split('-').map(Number),offset=(new Date(Date.UTC(y,m-1,1)).getUTCDay()+6)%7,days=new Date(Date.UTC(y,m,0)).getUTCDate(),checked=new Set(d.checkins),trained=new Map(d.trainingDays.map(x=>[x.play_date,x]));
    const cells=Array.from({length:Math.ceil((offset+days)/7)*7},(_,i)=>{const n=i-offset+1;if(n<1||n>days)return '<td></td>';const date=`${d.month}-${String(n).padStart(2,'0')}`,train=trained.get(date),signed=checked.has(date);return `<td><span class="calendar-day ${signed?'checked':''} ${train?'trained':''} ${date===d.today?'today':''}" aria-label="${date}${signed?'，已签到':''}${train?`，训练 ${train.sessions} 次 ${train.minutes} 分钟`:''}">${n}${train?'<i aria-hidden="true"></i>':''}</span></td>`;});
    return `<section class="growth-card"><div class="section-heading"><h2>我的签到日历</h2><span class="optional">本月 ${checked.size} 天</span></div><div class="calendar-controls"><button class="small-button" data-action="growth-month" data-month="${shiftMonth(d.month,-1)}">上月</button><strong>${y} 年 ${m} 月</strong><button class="small-button" data-action="growth-month" data-month="${shiftMonth(d.month,1)}" ${d.month>=d.today.slice(0,7)?'disabled':''}>下月</button></div><table class="checkin-calendar"><caption class="sr-only">${d.month} 签到与训练日历</caption><thead><tr>${['一','二','三','四','五','六','日'].map(n=>`<th scope="col">${n}</th>`).join('')}</tr></thead><tbody>${Array.from({length:cells.length/7},(_,i)=>`<tr>${cells.slice(i*7,i*7+7).join('')}</tr>`).join('')}</tbody></table><div class="calendar-legend"><span><i class="checked-legend"></i>已签到</span><span><i class="trained-legend"></i>有训练记录</span></div><p class="growth-note">签到按北京时间计算；训练日期保留填写的日期。</p></section>`;
  }
  function trend(){
    const monthly=model.data.monthlyRatings||[],source=monthly.length?'月度自评':'场次自评均值',rows=monthly.length?monthly.map(r=>({...r,samples:1,total:Hexagon.dimensions.every(d=>r[d.key]!==null)?Hexagon.dimensions.reduce((n,d)=>n+r[d.key],0):null})):model.data.history;
    const key=model.metric,max=key==='total'?60:10,label=key==='total'?'总分':Hexagon.dimensions.find(d=>d.key===key).label;
    const select=`<label class="sr-only" for="growth-metric">选择自评指标</label><select id="growth-metric"><option value="total" ${key==='total'?'selected':''}>总分 /60</option>${Hexagon.dimensions.map(d=>`<option value="${d.key}" ${key===d.key?'selected':''}>${d.label} /10</option>`).join('')}</select>`;
    const valid=r=>typeof r[key]==='number'&&Number.isFinite(r[key]),ordinal=s=>Number(s.slice(0,4))*12+Number(s.slice(5,7));
    let content='<div class="trend-empty"><span class="hex-token">6</span><h3>这个维度还在待测。</h3><p>更新月度能力后，这里会留下变化。总分只在六项都已测时显示。</p></div>';
    if(rows.some(valid)){
      const first=ordinal(rows[0].month),last=ordinal(rows.at(-1).month),coords=rows.map(r=>({x:first===last?195:48+(ordinal(r.month)-first)/(last-first)*280,y:valid(r)?195-r[key]/max*155:null,r}));
      const grid=[0,.5,1].map(n=>`<line x1="48" x2="328" y1="${195-n*155}" y2="${195-n*155}" class="trend-grid"/><text x="36" y="${200-n*155}" text-anchor="end">${max*n}</text>`).join('');
      const path=coords.map((p,i)=>p.y===null?'':`${i&&coords[i-1].y!==null&&ordinal(p.r.month)-ordinal(coords[i-1].r.month)===1?'L':'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
      const points=coords.filter(p=>p.y!==null).map(p=>`<circle cx="${p.x}" cy="${p.y}" r="4.5"><title>${p.r.month}：${p.r[key].toFixed(1)} 分</title></circle>`).join('');
      const ticks=`<text x="48" y="225">${rows[0].month}</text>${rows.length>1?`<text x="328" y="225" text-anchor="end">${rows.at(-1).month}</text>`:''}`;
      const description=rows.map(r=>`${r.month} ${valid(r)?r[key].toFixed(1)+' 分':'待测'}`).join('；');
      content=`<svg class="growth-trend" viewBox="0 0 360 245" role="img" aria-label="${e(label)}${source}：${e(description)}">${grid}<path d="${path}"/>${points}${ticks}</svg><p class="growth-note">${source} · 只与自己比较；待测不计为零。</p>`;
    }
    if(rows.length)content+=`<details class="growth-data"><summary>查看已保存的分数</summary><table><thead><tr><th scope="col">月份</th><th scope="col">${e(label)}</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${r.month}</td><td>${valid(r)?r[key].toFixed(1)+' /'+max:'待测'}</td></tr>`).join('')}</tbody></table></details>`;
    return `<section class="growth-card"><div class="section-heading"><h2>我的能力变化</h2>${select}</div>${content}</section>`;
  }
  function timeline(){const d=model.data,total=Number(d.summary.records),pages=Math.max(1,Math.ceil(total/20));return `<section class="growth-timeline"><div class="section-heading"><div><h2>一路练过来的记录</h2><p class="growth-note">${total} 场打球与训练 · ${d.summary.training_days} 个训练日</p></div><button class="text-button" data-action="training">记一次训练</button></div><div class="feed">${d.records.length?d.records.map(recordCard).join(''):'<div class="empty"><span class="empty-mark">🎾</span><h3>第一场，就从今天开始。</h3><p>记下练习、效果和下一步，慢慢看见自己的成长。</p><button class="primary" data-action="training">记录第一次训练</button></div>'}</div>${pages>1?`<div class="growth-pagination"><button class="secondary" data-action="growth-page" data-page="${d.page-1}" ${d.page===0?'disabled':''}>上一页</button><span>第 ${d.page+1} / ${pages} 页</span><button class="secondary" data-action="growth-page" data-page="${d.page+1}" ${d.page+1>=pages?'disabled':''}>下一页</button></div>`:''}</section>`;}
  function page(){
    const m=me();if(!m)return `<div class="page-heading"><div><p class="eyebrow">MY TENNIS JOURNEY</p><h1>我的成长档案</h1></div></div>${joinBanner()}`;
    const heading=`<div class="page-heading"><div><p class="eyebrow">MY TENNIS JOURNEY</p><h1>我的成长档案</h1><p class="subtext">今天练一点，下一次接着进步。</p></div><button class="primary" data-action="training">${icon('plus')}记录训练</button></div>`;
    const profile=`<div class="my-card"><div class="identity">${avatar(m,true)}<div><h2>${e(m.nickname)}</h2><small>${e(m.bio||'先打球，慢慢熟。')}</small></div></div><button class="secondary" data-action="profile">编辑我的名片</button></div>`;
    if(model.error)return `${heading}${profile}<div class="error-panel"><p>${e(model.error)}</p><button class="secondary" data-action="refresh">重试</button></div>`;
    if(!model.data)return `${heading}<p class="loading-line">正在翻开你的成长记录…</p>`;
    return `${heading}${checkinBar()}${summary()}${nextPlan()}<div class="growth-grid">${calendar()}${trend()}</div>${profile}${monthlySection(m)}${Hexagon.memberSummary(m)}${timeline()}`;
  }
  return {model,projects,effects,load,reset,checkinBar,form,bindForm,readTraining,recordDetails,page,shiftMonth};
})();
