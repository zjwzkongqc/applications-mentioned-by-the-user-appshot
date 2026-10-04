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
    if(!record || (average && !Number(record.rated_count)))return null;
    const values = Object.fromEntries(dimensions.map(d=>[d.key,Number(record[average?`avg_${d.key}`:d.key])]));
    return dimensions.every(d=>values[d.key]>=1&&values[d.key]<=10)?values:null;
  }
  function chart(values,label='本场六维自评') {
    const description=values?dimensions.map(d=>`${d.label} ${format(values[d.key])} /10`).join('，'):'尚未填写六维自评';
    const rings=Array.from({length:5},(_,i)=>`<polygon class="hex-grid" points="${coordinates(dimensions.map((_,j)=>point(j,86*(i+1)/5)))}"/>`).join('');
    const axes=dimensions.map((_,i)=>{const [x,y]=point(i,86);return `<line class="hex-axis" x1="150" y1="150" x2="${x}" y2="${y}"/>`;}).join('');
    const shape=values?`<polygon class="hex-area" points="${coordinates(dimensions.map((d,i)=>point(i,86*values[d.key]/10)))}"/>${dimensions.map((d,i)=>{const [x,y]=point(i,86*values[d.key]/10);return `<circle class="hex-point" cx="${x}" cy="${y}" r="3.5"/>`;}).join('')}`:'';
    const labels=dimensions.map((d,i)=>{const [x,y]=point(i,116);return `<text class="hex-label" x="${x}" y="${y-2}" text-anchor="middle">${d.label}<tspan class="hex-value" x="${x}" dy="20">${values?`${format(values[d.key])}/10`:'—'}</tspan></text>`;}).join('');
    return `<svg class="hex-radar ${values?'':'unrated'}" viewBox="0 0 300 300" role="img" aria-label="${escape(label)}：${escape(description)}">${rings}${axes}${shape}${labels}</svg>`;
  }
  function format(value) {return Number.isInteger(value)?String(value):value.toFixed(1);}
  function total(values,label='本场自评总分') {const value=values?format(dimensions.reduce((sum,d)=>sum+values[d.key],0)):'—';return `<div class="hex-total"><span>${label}</span><strong>${value}<small>/60</small></strong></div>`;}
  function highlight(values) {
    const max=Math.max(...Object.values(values));
    const best=dimensions.filter(d=>values[d.key]===max);
    return best.length===6?'六项同分，也是一种风格':`本场最满意：${best.slice(0,2).map(d=>d.label).join(' / ')}`;
  }
  function memberSummary(member,compact=false) {
    const values=scores(member,true),count=Number(member.rated_count||0);
    if(compact)return `<div class="member-hex"><div class="hex-caption"><span>六维自评均值</span><span>${count} 场</span></div>${chart(values,`${member.nickname}的六维自评均值`)}${total(values,'自评均值总分')}${values?'':'<p class="hex-unrated">六边形待点亮，下一场记个自评吧。</p>'}</div>`;
    return `<section class="hex-summary"><div class="hex-summary-copy"><p class="eyebrow">MY SIX-SIDED STORY</p><h2>我的网球六边形</h2><p>${values?`已积累 ${count} 场自评，每一场都有自己的形状。`:'还没点亮第一张六边形。记录一场球，留下今天的六维状态。'}</p><div class="hex-summary-badges">${badge(member)}<span class="hex-sample">自评均值 · ${count} 场</span></div><p class="hex-explainer">1 待加强 · 5 基本到位 · 10 很满意<br>只汇总填写过的自评，记录自己的当场感受。</p><button class="secondary" data-action="record">记下今天的六边形</button></div><div class="hex-summary-chart">${chart(values,`${member.nickname}的六维自评均值`)}${total(values,'自评均值总分')}</div></section>`;
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
    return `<section class="hex-form"><label class="hex-toggle" for="enable-hex"><span class="hex-token" aria-hidden="true">6</span><span><strong>记下本场六维自评</strong><small>选填 · 今天，你是几边形？</small></span><input id="enable-hex" type="checkbox" ${values?'checked':''} aria-controls="hex-fields"></label><div id="hex-fields" ${values?'':'hidden'}><p class="hex-scale">1 待加强 · 5 基本到位 · 10 很满意</p><div class="hex-score-grid">${dimensions.map(d=>`<fieldset class="hex-score-row"><legend>${d.label}</legend><div class="hex-score-options">${Array.from({length:10},(_,i)=>i+1).map(n=>`<label><input type="radio" name="skill_${d.key}" value="${n}" aria-label="${d.label} ${n} 分" ${values?.[d.key]===n?'checked':''} ${values?'required':'disabled'}><span>${n}</span></label>`).join('')}</div></fieldset>`).join('')}</div><div id="hex-preview">${chart(values,'本场六维自评预览')}${total(values)}</div><p id="hex-preview-caption" class="hex-preview-caption">${values?highlight(values):'填完六项，就能看到今天的六边形。'}</p></div></section>`;
  }
  function bindForm(form) {
    const toggle=form.querySelector('#enable-hex'),fields=form.querySelector('#hex-fields');
    const update = () => {
      fields.hidden=!toggle.checked;
      fields.querySelectorAll('input[type=radio]').forEach(input=>{input.disabled=!toggle.checked;input.required=toggle.checked;});
      const values=readForm(form,false);
      form.querySelector('#hex-preview').innerHTML=chart(values,'本场六维自评预览')+total(values);
      form.querySelector('#hex-preview-caption').textContent=values?highlight(values):'填完六项，就能看到今天的六边形。';
    };
    toggle.addEventListener('change',update);
    fields.addEventListener('change',update);
  }
  function readForm(form,validate=true) {
    if(!form.querySelector('#enable-hex').checked)return null;
    const values=Object.fromEntries(dimensions.map(d=>[d.key,Number(form.querySelector(`input[name="skill_${d.key}"]:checked`)?.value)]));
    if(dimensions.some(d=>!Number.isInteger(values[d.key])||values[d.key]<1||values[d.key]>10)){
      if(validate)throw new Error('请为六个维度各选一个分数，或取消本场自评。');
      return null;
    }
    return values;
  }
  return {dimensions,scores,chart,total,memberSummary,badge,recordChip,form,bindForm,readForm,highlight};
})();
