const Hexagon = (() => {
  const dimensions = [
    {key:'forehand',label:'正手稳定性'}, {key:'backhand',label:'反手稳定性'},
    {key:'serve',label:'发球控制'}, {key:'return_skill',label:'接发球能力'},
    {key:'net',label:'网前截击'}, {key:'footwork',label:'移动与回位'}
  ];
  const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const point = (index,radius) => {
    const angle = (-90 + index*60)*Math.PI/180;
    return [150+Math.cos(angle)*radius,150+Math.sin(angle)*radius];
  };
  const coordinates = points => points.map(p=>p.map(n=>n.toFixed(2)).join(',')).join(' ');
  function scores(record,average=false) {
    if(average&&record?.rating)return scores(record.rating);
    if(!record)return null;
    const values=Object.fromEntries(dimensions.map(d=>{const raw=record[average?`avg_${d.key}`:d.key];return [d.key,typeof raw==='number'&&Number.isFinite(raw)&&raw>=0&&raw<=10?raw:null];}));
    return dimensions.some(d=>values[d.key]!==null)?values:null;
  }
  function chart(values,label='本场六维自评') {
    const known=d=>values&&values[d.key]!==null&&values[d.key]!==undefined;
    const description=dimensions.map(d=>`${d.label} ${known(d)?format(values[d.key])+' /10':'待测'}`).join('，');
    const rings=Array.from({length:5},(_,i)=>`<polygon class="hex-grid" points="${coordinates(dimensions.map((_,j)=>point(j,86*(i+1)/5)))}"/>`).join('');
    const axes=dimensions.map((_,i)=>{const [x,y]=point(i,86);return `<line class="hex-axis" x1="150" y1="150" x2="${x}" y2="${y}"/>`;}).join('');
    const full=dimensions.every(known),shape=full?`<polygon class="hex-area" points="${coordinates(dimensions.map((d,i)=>point(i,86*values[d.key]/10)))}"/>`:dimensions.map((d,i)=>{const next=dimensions[(i+1)%6];if(!known(d)||!known(next))return '';const [x1,y1]=point(i,86*values[d.key]/10),[x2,y2]=point((i+1)%6,86*values[next.key]/10);return `<line class="hex-partial" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;}).join('');
    const dots=dimensions.map((d,i)=>{if(!known(d))return '';const [x,y]=point(i,86*values[d.key]/10);return `<circle class="hex-point" cx="${x}" cy="${y}" r="3.5"/>`;}).join('');
    const labels=dimensions.map((d,i)=>{const [x,y]=point(i,116);return `<text class="hex-label" x="${x}" y="${y-2}" text-anchor="middle">${d.label}<tspan class="hex-value" x="${x}" dy="20">${known(d)?`${format(values[d.key])}/10`:'待测'}</tspan></text>`;}).join('');
    return `<svg class="hex-radar ${values?'':'unrated'}" viewBox="0 0 300 300" role="img" aria-label="${escape(label)}：${escape(description)}">${rings}${axes}${shape}${dots}${labels}</svg>`;
  }
  function format(value) {return Number.isInteger(value)?String(value):value.toFixed(1);}
  function total(values,label='本场自评总分') {const count=dimensions.filter(d=>values&&values[d.key]!==null).length;if(count<6)return `<div class="hex-total"><span>已测维度</span><strong>${count}<small>/6</small></strong></div>`;return `<div class="hex-total"><span>${label}</span><strong>${format(dimensions.reduce((sum,d)=>sum+values[d.key],0))}<small>/60</small></strong></div>`;}
  function highlight(values) {const known=dimensions.filter(d=>values?.[d.key]!==null&&values?.[d.key]!==undefined);if(!known.length)return '能力待测';const max=Math.max(...known.map(d=>values[d.key])),best=known.filter(d=>values[d.key]===max);return best.length===6?'六项同分，也是一种风格':`本场最满意：${best.slice(0,2).map(d=>d.label).join(' / ')}`;}
  function memberSummary(member,compact=false) {
    const values=scores(member,true),count=Number(member.rated_count||0);
    if(compact)return `<div class="member-hex"><div class="hex-caption"><span>${member.rating?member.rating.month+' 月度能力':'历史场次自评均值'}</span><span>${member.rating?'本人自评':count+' 场'}</span></div>${chart(values,`${member.nickname}的六维自评均值`)}${total(values,'自评均值总分')}${values?'':'<p class="hex-unrated">六边形待点亮，下一场记个自评吧。</p>'}</div>`;
    return `<section class="hex-summary"><div class="hex-summary-copy"><p class="eyebrow">MY SIX-SIDED STORY</p><h2>我的网球六边形</h2><p>${values?`已积累 ${count} 场自评，每一场都有自己的形状。`:'还没点亮第一张六边形。记录一场球，留下今天的六维状态。'}</p><div class="hex-summary-badges">${badge(member)}<span class="hex-sample">自评均值 · ${count} 场</span></div><p class="hex-explainer">0 起步 · 5 基本到位 · 10 很满意 · 待测为空<br>只汇总填写过的自评，记录自己的当场感受。</p><button class="secondary" data-action="record">记下今天的六边形</button></div><div class="hex-summary-chart">${chart(values,`${member.nickname}的六维自评均值`)}${total(values,'自评均值总分')}</div></section>`;
  }
  function badge(member) {
    const n=Number(member.record_count),level=n>=10?10:n>=5?5:n>=1?1:0;
    const text=level===10?'十场常客':level===5?'球场熟面孔':level===1?'首场留念':'刚刚入场';
    return `<span class="hex-badge ${level?'earned':''}"><span class="hex-token" aria-hidden="true">${level||'·'}</span>${text}</span>`;
  }
  function recordChip(record) {
    const values=scores(record);
    return values?`<button class="hex-record" data-action="view-hex" data-id="${escape(record.id)}"><span class="hex-token" aria-hidden="true">6</span><span><strong>本场六边形</strong><small>${highlight(values)}</small></span><span class="hex-record-hint">查看自评</span></button>`:'';
  }
  function form(record) {
    const values=scores(record);
    return `<section class="hex-form"><label class="hex-toggle" for="enable-hex"><span class="hex-token" aria-hidden="true">6</span><span><strong>记下本场六维自评</strong><small>选填 · 每项可以保留待测</small></span><input id="enable-hex" type="checkbox" ${values?'checked':''} aria-controls="hex-fields"></label><div id="hex-fields" ${values?'':'hidden'}><p class="hex-scale">0 起步 · 5 基本到位 · 10 很满意</p><div class="hex-score-grid">${dimensions.map(d=>`<div class="rating-select"><label for="skill-${d.key}">${d.label}</label><select id="skill-${d.key}" name="skill_${d.key}" ${values?'':'disabled'}><option value="">待测</option>${Array.from({length:11},(_,n)=>`<option value="${n}" ${values?.[d.key]===n?'selected':''}>${n} 分</option>`).join('')}</select></div>`).join('')}</div><div id="hex-preview">${chart(values,'本场六维自评预览')}${total(values)}</div><p id="hex-preview-caption" class="hex-preview-caption">${values?highlight(values):'选分数后预览本场能力。'}</p></div></section>`;
  }
  function bindForm(form) {
    const toggle=form.querySelector('#enable-hex'),fields=form.querySelector('#hex-fields');
    const update=()=>{fields.hidden=!toggle.checked;fields.querySelectorAll('select').forEach(input=>input.disabled=!toggle.checked);const values=readForm(form,false);form.querySelector('#hex-preview').innerHTML=chart(values,'本场六维自评预览')+total(values);form.querySelector('#hex-preview-caption').textContent=highlight(values);};
    toggle.addEventListener('change',update);fields.addEventListener('change',update);
  }
  function readForm(form,validate=true) {
    if(!form.querySelector('#enable-hex').checked)return null;
    const values=Object.fromEntries(dimensions.map(d=>{const raw=form.querySelector(`[name="skill_${d.key}"]`).value;return [d.key,raw===''?null:Number(raw)];}));
    if(dimensions.some(d=>values[d.key]!==null&&(!Number.isInteger(values[d.key])||values[d.key]<0||values[d.key]>10))){if(validate)throw new Error('每项请选择 0–10 分，或保留待测。');return null;}
    return values;
  }
  return {dimensions,scores,chart,total,memberSummary,badge,recordChip,form,bindForm,readForm,highlight};
})();
