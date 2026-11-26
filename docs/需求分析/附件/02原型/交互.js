// Presentation and prototype interactions. Business data remains local to this page.
let selected=false;
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function displayTime(m){return clockText(m);}
function go(tab){const b=document.querySelector('[data-tab="'+tab+'"]');if(b&&!b.hidden)b.click();}
function summary(){const s=minute($('start').value),e=minute($('end').value);$('summaryDate').textContent=$('day').value.slice(5).replace('-','月')+'日';$('summaryTime').textContent=$('start').value+'—'+$('end').value;$('summaryDuration').textContent=e>s?(e-s)+'分钟':'请选择有效时段';$('reserve').disabled=!selected||!$('agree').checked;}
document.querySelector('[data-seat="A01"]').onclick=()=>{selected=true;document.querySelector('[data-seat="A01"]').classList.add('selected');document.querySelector('[data-seat="A01"]').setAttribute('aria-pressed','true');document.querySelector('[data-seat="A01"] small').textContent='已选择';$('selectedSeat').textContent='A01';$('seatAttributes').textContent='靠窗 · 电源插座';summary();};
['start','end','day','agree'].forEach(id=>$(id).addEventListener('change',summary));
const originalRender=render;
render=function(){
 originalRender();
 if(res){$('reservationView').innerHTML='<div class="record-main"><strong>'+esc(res.seat||'A01')+' <span class="muted small">图书馆二层</span></strong><span class="status">'+esc(res.state)+'</span></div><p class="record-line">'+esc(res.day)+'　'+esc(res.start)+'—'+esc(res.end)+'</p><dl class="summary"><dt>预约编号</dt><dd>DEMO-R001</dd><dt>签到截止</dt><dd>'+esc(res.deadline)+'</dd>'+(res.state==='暂离中'?'<dt>返回截止</dt><dd>'+displayTime(res.leaveDeadline)+'</dd>':'')+'<dt>处理结果</dt><dd>'+esc(res.reason)+'</dd></dl>';
 }else $('reservationView').innerHTML='<div class="empty"><svg viewBox="0 0 48 48"><rect x="11" y="7" width="26" height="34" rx="3"/><path d="M17 17h14M17 24h14M17 31h8"/></svg><p>暂无预约</p><button class="link" id="emptyGoBook">去预约座位 →</button></div>';
 if($('emptyGoBook'))$('emptyGoBook').onclick=()=>go('book');
 $('cancel').hidden=!res||res.state!=='待签到';$('signin').hidden=!res||res.state!=='待签到';$('leave').hidden=!res||res.state!=='使用中';$('returnSeat').hidden=!res||res.state!=='暂离中';$('signout').hidden=!res||!['使用中','暂离中'].includes(res.state);
 $('mineHistory').innerHTML=history.length?'<ul class="timeline">'+history.slice().reverse().map(h=>'<li>'+esc(h)+'</li>').join('')+'</ul>':'<p class="muted small">暂无操作记录。</p>';
 $('supplement').disabled=!complaint||complaint.state!=='已答复';$('closeComplaint').disabled=!complaint||complaint.state!=='已答复';
 $('adminSeats').innerHTML=['A01','A02','A03','A04'].map(seat=>{const state=blockActive(seat)||seat==='A03'?'已停用':seat==='A01'?(res?res.state:'可预约'):seeded[seat];return '<tr><td>'+seat+'</td><td>'+(seat==='A01'?'靠窗 / 电源':'电源')+'</td><td><span class="status '+(state==='可预约'?'green':'gray')+'">'+state+'</span></td><td>'+(seat==='A01'&&res?'DEMO-R001':seat==='A02'?'U02':seat==='A04'?'U03':'—')+'</td></tr>';}).join('');
 const a=document.querySelector('[data-seat="A01"]');const unavailable=blockIntersects('A01',dateMinute($('day').value,$('start').value),dateMinute($('day').value,$('end').value));a.disabled=unavailable||!!res;a.classList.toggle('blocked',unavailable);a.classList.toggle('selected',selected&&!a.disabled);a.setAttribute('aria-pressed',String(selected&&!a.disabled));a.querySelector('small').textContent=unavailable?'时段停用':res?res.state:selected?'已选择':'可预约';
};
$('leave').onclick=()=>{if(!userGuard())return;expiry();if(!res||res.state!=='使用中'){say('当前状态不能暂离。',true);return;}res.state='暂离中';res.leaveStart=nowMin();res.leaveDeadline=Math.min(nowMin()+15,res.e);res.reason='请在'+displayTime(res.leaveDeadline)+'前返回';log('暂离，保留至'+displayTime(res.leaveDeadline));say('已登记暂离，请在'+displayTime(res.leaveDeadline)+'前返回。');};
$('returnSeat').onclick=()=>{if(!userGuard())return;expiry();if(!res||res.state!=='暂离中'){say('暂离已结束或超时，不能恢复该预约。',true);return;}res.state='使用中';res.reason='已返回座位';log('返回座位');say('已返回，继续使用。');};
const reserveAction=$('reserve').onclick;$('reserve').onclick=()=>{if(!selected){say('请选择座位。',true);return;}const had=!!res;reserveAction();if(!had&&res&&!$('lost').checked){$('successDetails').textContent='图书馆二层 · A01\n'+res.day+' '+res.start+'—'+res.end;$('successDeadline').textContent='请在'+res.start+'至'+res.deadline+'之间完成签到。';$('bookingResult').showModal();}};
$('openSettings').onclick=()=>$('settings').showModal();document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());$('goMine').onclick=()=>{$('bookingResult').close();go('mine');};
function updateClock(){
 const val=beijingLocal(businessNow());
 $('topClock').textContent=val.slice(5,10).replace('-','月')+'日 '+val.slice(11,16)+' · '+(sceneTime===null?'北京时间':'场景时间');
 if(document.activeElement!==$('clock'))$('clock').value=val;
 const range=bookingDates();$('day').min=range.today;$('day').max=range.last;
 expiry();
}
function initialPeriod(){
 let ms=Math.ceil((businessNow()+60000)/900000)*900000;
 if(beijingLocal(ms).slice(11,16)>'23:00')ms=Date.parse(beijingLocal(ms+86400000).slice(0,10)+'T00:00:00+08:00');
 $('day').value=beijingLocal(ms).slice(0,10);$('start').value=beijingLocal(ms).slice(11,16);$('end').value=beijingLocal(ms+3600000).slice(11,16);summary();
}
$('applyClock').onclick=()=>{
 const next=Date.parse($('clock').value+':00+08:00');
 if(!Number.isFinite(next)){say('请输入有效时间。',true);return;}
 if(res&&next<businessNow()){say('已有预约时不能倒退时间，请先重置。',true);return;}
 sceneTime=next;updateClock();if(!res)initialPeriod();render();say('场景时间已更新。');
};
$('syncClock').onclick=()=>{
 if(res&&Date.now()<businessNow()){say('场景中已有预约，请重置后同步北京时间。',true);return;}
 sceneTime=null;updateClock();if(!res)initialPeriod();render();say('已同步北京时间。');
};
$('query').onclick=()=>{expiry();render();summary();say('座位状态已更新。');};
updateClock();initialPeriod();setInterval(updateClock,1000);
const roleAction=$('role').onchange;$('role').onchange=()=>{roleAction();const student=$('role').value==='U01';$('profileName').textContent=student?'学生 U01':'管理员 '+$('role').value;document.querySelector('.avatar').textContent=student?'U':'M';document.querySelectorAll('[data-tab]').forEach(b=>{b.hidden=student?['admin','stats'].includes(b.dataset.tab):!['admin','stats'].includes(b.dataset.tab);});$('settings').close();go(student?'book':'admin');render();};
document.querySelectorAll('[data-admin-view]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-admin-view]').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('.admin-view').forEach(x=>x.classList.toggle('active',x.id===b.dataset.adminView));});
// The unprivileged manager can open a denied view, but must not see R1 records.
function applyAdminScope(){const allowed=$('role').value==='M1';document.querySelectorAll('.admin-view').forEach(v=>v.classList.toggle('scope-denied',!allowed));let notice=$('scopeDenied');if(!notice){notice=document.createElement('p');notice.id='scopeDenied';notice.className='inline-note';$('admin').querySelector('.subnav').after(notice);}notice.textContent='当前账号未获R1管理权限，无法查看或处理该场地记录。';notice.hidden=allowed;}
const roleFull=$('role').onchange;$('role').onchange=()=>{roleFull();applyAdminScope();};
const oldRenderScope=render;render=function(){oldRenderScope();applyAdminScope();};
document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{if(b.dataset.tab==='mine')render();window.scrollTo({top:0,behavior:'instant'});}));
// Show a pending snapshot before the first successful response, and keep failures explicit.
const originalRefresh=refreshStats;refreshStats=function(){originalRefresh();setTimeout(()=>{const x=$('refreshStatus');x.textContent=x.textContent.replaceAll('模拟快照','数据').replaceAll('模拟请求','请求').replace('切M1再查看。','').replaceAll('成功读取次数：','刷新次数：');},350);};
$('refresh').onclick=refreshStats;
render();summary();

for(const tab of document.querySelectorAll('[data-tab]'))tab.addEventListener('click',()=>{$('message').className='';});


function parseLocalTime(value){return value?Date.parse(value+':00+08:00')/60000:NaN;}
function fullTime(minutes){return beijingLocal(minutes*60000).replace('T',' ');}
function blockIntersects(seat,s,e){const b=blocked.get(seat);return !!b&&Number.isFinite(s)&&Number.isFinite(e)&&s<b.end&&b.start<e;}
function blockActive(seat){const b=blocked.get(seat),t=nowMin();return !!b&&b.start<=t&&t<b.end;}
let seedDay='',seedRecords={},correctionLog='';
function seatBooking(seat){
 if(res&&(res.seat||'A01')===seat)return res;
 if(seat==='A01')return null;
 const day=beijingLocal(businessNow()).slice(0,10);
 if(seedDay!==day){seedDay=day;seedRecords={A02:{state:'使用中',s:dateMinute(day,'13:00'),e:dateMinute(day,'17:00')},A04:{state:'待签到',s:dateMinute(day,'14:00'),e:dateMinute(day,'15:00')}};}
 const r=seedRecords[seat];if(r)r.state=seeded[seat];return r;
}
function invalidateBlockPreview(){preview=null;$('commitBlock').disabled=true;$('cleared').checked=false;$('clearanceField').hidden=true;$('impact').textContent='停用安排已更改，请重新预览影响。';}
function initializeBlockPeriod(){const start=Math.ceil(nowMin());$('blockStart').value=beijingLocal(start*60000);$('blockEnd').value=beijingLocal((start+60)*60000);}
function blockInput(){
 const start=$('blockNow').checked?nowMin():parseLocalTime($('blockStart').value),end=parseLocalTime($('blockEnd').value),seat=$('blockSeat').value,reason=$('blockReason').value.trim();
 if(!reason){say('请填写停用原因。',true);return null;}
 if(!Number.isFinite(start)||!Number.isFinite(end)){say('请选择完整的停用开始和结束时间。',true);return null;}
 if(!$('blockNow').checked&&start<nowMin()){say('计划开始时间不能早于当前时间。',true);return null;}
 if(end<=start){say('结束时间必须晚于开始时间。',true);return null;}
 return {seat,start,end,reason,immediate:$('blockNow').checked};
}
function affectedBooking(seat,start,end){const r=seatBooking(seat);return r&&['待签到','使用中','暂离中'].includes(r.state)&&r.s<end&&start<r.e?r:null;}
$('blockNow').onchange=()=>{$('blockStart').disabled=$('blockNow').checked;if($('blockNow').checked)$('blockStart').value=beijingLocal(businessNow());invalidateBlockPreview();};
for(const id of ['blockSeat','blockStart','blockEnd','blockReason'])$(id).addEventListener('input',invalidateBlockPreview);
$('previewBlock').onclick=()=>{
 if(!adminGuard())return;expiry();const p=blockInput();if(!p)return;
 const existing=blocked.get(p.seat);if(existing&&existing.end>nowMin()){say('该座位已有停用安排，请先恢复座位再调整时段。',true);return;}
 const affected=affectedBooking(p.seat,p.start,p.end);
 if(affected&&['使用中','暂离中'].includes(affected.state)&&!p.immediate){invalidateBlockPreview();say('计划停用与正在使用的预约重叠，请调整时段，或选择立即停用并核实清场。',true);return;}
 preview={...p,state:affected?affected.state:null,bookingStart:affected?.s,bookingEnd:affected?.e};
 const active=affected&&['使用中','暂离中'].includes(affected.state);
 $('impact').innerHTML='<strong>'+esc(p.seat)+' · '+esc(fullTime(p.start))+' 至 '+esc(fullTime(p.end))+'</strong><p>'+(active?'该座位正在使用。清场确认后结束本次预约，释放座位；此次关闭不计违约，并返还对应预约额度。':affected?'该时段有待签到预约。确认后将取消该预约，不计违约，并返还对应预约额度。':'该时段没有需要取消或关闭的预约。停用期间不可创建重叠预约。')+'</p>';
 $('cleared').checked=false;$('clearanceField').hidden=!active;$('commitBlock').disabled=false;say('请核对停用时段及受影响预约。');
};
$('commitBlock').onclick=()=>{
 if(!adminGuard())return;expiry();if(!preview){say('请先预览停用影响。',true);return;}
 const input=blockInput();if(!input)return;const p=preview;
 if(input.seat!==p.seat||input.reason!==p.reason||input.end!==p.end||input.immediate!==p.immediate||(!p.immediate&&input.start!==p.start)){invalidateBlockPreview();say('停用安排已变化，请重新预览。',true);return;}
 const affected=affectedBooking(p.seat,input.start,p.end);
 if((affected?.state||null)!==p.state||affected?.s!==p.bookingStart||affected?.e!==p.bookingEnd){invalidateBlockPreview();say('受影响预约已变化，请重新预览。',true);return;}
 if(affected&&['使用中','暂离中'].includes(affected.state)&&!$('cleared').checked){say('请先通知使用者离场并确认现场已清空。',true);return;}
 blocked.set(p.seat,{start:input.start,end:p.end,reason:p.reason});
 if(affected){affected.state=affected.state==='待签到'?'已取消':'异常关闭';affected.reason='场地停用，免罚并返还对应预约额度';if(affected!==res)seeded[p.seat]=affected.state;}
 const description=p.seat+' 停用：'+fullTime(input.start)+' 至 '+fullTime(p.end);
 preview=null;$('commitBlock').disabled=true;$('clearanceField').hidden=true;$('impact').textContent=description+'。到时自动恢复可预约，原预约保持处理结果。';log(description);say('停用安排已保存。');render();
};
$('restore').onclick=()=>{if(!adminGuard())return;const seat=$('blockSeat').value;if(!blocked.has(seat)||blocked.get(seat).end<=nowMin()){say('该座位当前没有待执行或生效的停用安排。',true);return;}blocked.delete(seat);invalidateBlockPreview();$('impact').textContent=seat+' 已提前恢复，原有取消或关闭记录保持不变。';log(seat+' 提前恢复');say('座位已恢复。');};

function complaintDetails(item=complaint){if(!item)return '';return '<div class="complaint-result"><div class="record-main"><strong>投诉 '+esc(item.id)+'</strong><span class="status">'+esc(item.state)+'</span></div><p><strong>处理答复：</strong>'+esc(item.reply||'尚未答复')+'</p>'+(item.supplements||[]).map((x,i)=>'<p><strong>补充说明 '+(i+1)+'：</strong>'+esc(x)+'</p>').join('')+'</div>';}
function renderFeedback(){
 const submitted=!complaintDraft&&!!complaint;
 $('complaintHeading').textContent=submitted?'投诉详情':'提交投诉或申诉';$('complaintType').disabled=submitted;$('complaintText').readOnly=submitted;$('complain').hidden=submitted;
 $('newComplaint').hidden=!submitted;
 if(submitted){$('complaintType').value=complaint.type;$('complaintText').value=complaint.text;}
 $('complaintHistoryField').hidden=!complaints.length;
 const options=complaints.slice().reverse().map(c=>'<option value="'+c.id+'">'+c.id+' · '+esc(c.type)+' · '+c.state+'</option>').join('');
 $('complaintHistory').innerHTML='<option value="">'+(complaintDraft?'正在填写新投诉':'选择记录')+'</option>'+options;
 $('complaintHistory').value=submitted?complaint.id:'';
 $('adminComplaintSelect').innerHTML=options||'<option value="">暂无投诉</option>';
 $('adminComplaintSelect').value=adminComplaintId||'';
 const item=complaints.find(c=>c.id===adminComplaintId);
 $('complaintView').innerHTML=submitted?complaintDetails():'';
 $('adminComplaint').innerHTML=item?'<p><strong>'+esc(item.type)+'</strong> · '+esc(item.text)+'</p>'+complaintDetails(item):'尚无投诉。';
 $('acceptComplaint').disabled=item?.state!=='待受理';$('replyComplaint').disabled=item?.state!=='处理中';
 const answered=submitted&&complaint.state==='已答复';$('supplement').hidden=!answered;$('closeComplaint').hidden=!answered;$('supplement').disabled=!answered;$('closeComplaint').disabled=!answered;if(!answered)$('supplementForm').hidden=true;
 $('violationView').textContent='违约状态：'+violation+'；预约限制：'+(restricted?'生效中':'已解除')+'。'+correctionLog;
 $('correct').disabled=violation==='已撤销';$('correct').textContent=violation==='已撤销'?'已完成纠正':'撤销违约并解除限制';
}
let complaintDraftText='',complaintDraftType='设施问题';
$('newComplaint').onclick=()=>{if(!userGuard())return;complaintDraft=true;$('complaintType').value=complaintDraftType;$('complaintText').value=complaintDraftText;$('supplementForm').hidden=true;render();$('complaintText').focus();};
$('complaintHistory').onchange=()=>{if(!userGuard())return;const item=complaints.find(c=>c.id===$('complaintHistory').value);if(!item)return;if(complaintDraft){complaintDraftText=$('complaintText').value;complaintDraftType=$('complaintType').value;}complaint=item;complaintDraft=false;$('supplementText').value='';$('supplementForm').hidden=true;render();};
$('adminComplaintSelect').onchange=()=>{if(!adminGuard())return;adminComplaintId=$('adminComplaintSelect').value;$('reply').value='';render();};
const submitComplaint=$('complain').onclick;$('complain').onclick=()=>{submitComplaint();if(!complaintDraft){complaintDraftText='';complaintDraftType='设施问题';}};
$('supplement').onclick=()=>{if(!userGuard()||complaint?.state!=='已答复')return;$('supplementForm').hidden=false;$('supplementText').focus();};
$('cancelSupplement').onclick=()=>{$('supplementForm').hidden=true;$('supplementText').value='';};
$('submitSupplement').onclick=()=>{if(!userGuard())return;if(complaint?.state!=='已答复'){say('投诉状态已变化，暂不能提交补充。',true);return;}const text=$('supplementText').value.trim();if(!text){say('请填写补充说明。',true);return;}complaint.supplements.push(text);complaint.state='处理中';$('supplementText').value='';render();say('补充说明已提交，管理员将继续处理。');};
$('viewFault').onclick=()=>{if(adminGuard())$('faultDetails').showModal();};
$('correct').onclick=()=>{if(adminGuard()&&violation==='生效')$('confirmCorrection').showModal();};
$('confirmCorrect').onclick=()=>{if(!adminGuard()||violation!=='生效')return;const reason=$('correctionReason').value.trim();if(!reason){say('请填写处理理由。',true);return;}violation='已撤销';restricted=false;correctionLog='处理人：M1；理由：'+reason;$('confirmCorrection').close();log('撤销V001并解除唯一依据的预约限制');say('已撤销违约并解除限制，处理历史已保留。');};
const renderBeforeFeedback=render;render=function(){renderBeforeFeedback();renderFeedback();};
const applyScene=$('applyClock').onclick;$('applyClock').onclick=()=>{const before=businessNow();applyScene();if(businessNow()!==before){initializeBlockPeriod();invalidateBlockPreview();}};
initializeBlockPeriod();render();
let previousBlockState='';setInterval(()=>{const state=[...blocked].map(([seat,b])=>seat+':'+(nowMin()<b.start?'scheduled':nowMin()<b.end?'active':'ended')).join('|');if(state!==previousBlockState){previousBlockState=state;render();}},1000);
