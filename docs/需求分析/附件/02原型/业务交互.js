
const $=id=>document.getElementById(id);let res=null,complaint=null,review=null,history=[],blocked=new Map(),preview=null,violation='生效',restricted=true,manual='无',current='book',inFlight=false,requestSeq=0,scopeVersion=0,lastSuccess='',refreshCount=0;
const seeded={A02:'使用中',A04:'待签到'};
let toastTimer;function say(text,error=false){text=text.replace(/(?:ST|CT|VT)-[0-9]+[： ]*/g,'').replaceAll('模拟','');$('message').textContent=text;$('message').className=error?'show error':'show';clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('message').className='',7000);}
function minute(s){const [h,m]=s.split(':').map(Number);return h*60+m;}
let sceneTime=null;
function businessNow(){return sceneTime===null?Date.now():sceneTime;}
function beijingLocal(ms){return new Date(ms+8*3600000).toISOString().slice(0,16);}
function dateMinute(day,time){return Date.parse(day+'T'+time+':00+08:00')/60000;}
function nowMin(){return businessNow()/60000;}
function clockText(m){return beijingLocal(m*60000).slice(11,16);}
function bookingDates(){const today=beijingLocal(businessNow()).slice(0,10);return {today,last:beijingLocal(Date.parse(today+'T00:00:00+08:00')+6*86400000).slice(0,10)};}
function clockStr(){return beijingLocal(businessNow()).replace('T',' ');}
function userGuard(){if($('role').value!=='U01'||$('wrongOwner').checked){say('权限不足：只能操作本人预约或反馈，数据保持不变。',true);return false;}return true;}
function adminGuard(){if($('role').value!=='M1'){say('权限不足：当前身份没有R1管理权限，未修改业务数据。',true);return false;}return true;}
function log(s){history.push(clockStr()+' '+s.replace(/(?:ST|CT|VT)-[0-9]+[： ]*/g,''));render();}
function render(){
 if(res){$('reservationView').innerHTML='<dl><dt>预约编号</dt><dd>DEMO-R001</dd><dt>用户 / 座位</dt><dd>U01 / R1-A01</dd><dt>时段</dt><dd>'+res.day+' '+res.start+'—'+res.end+'</dd><dt>状态</dt><dd><span class="badge">'+res.state+'</span></dd><dt>签到截止</dt><dd>'+res.deadline+'</dd><dt>结束 / 原因</dt><dd>'+res.reason+'</dd></dl>';}else $('reservationView').textContent='尚未创建U01预约。请先完成“找座预约”。';
 $('mineHistory').textContent=history.length?history.join('；'):'尚无操作历史。';
 const text=complaint?complaint.id+' / '+complaint.type+' / '+complaint.state+' / 说明：'+complaint.text+' / 答复：'+(complaint.reply||'尚未答复'):'尚无投诉。';$('complaintView').textContent=text;$('adminComplaint').textContent=text;
 $('violationView').textContent='V001：'+violation+'；关联限制：'+(restricted?'有效':'已解除')+'。';$('manualView').textContent='新登记事件V002：'+manual+'。';
 $('reviewView').textContent=review?'当前评分：'+review.score+'；修改次数：'+review.edits+'；文字：'+review.text:'尚无评价。';
}
function expiry(){if(!res)return;const t=nowMin();if(res.state==='待签到'&&t>=res.cutoff){if(res.occupancyProtected){
 res.state='已取消';res.reason='占座保护到期，座位已免罚释放';res.protectionExpired=true;log(res.reason);
 }else{res.state='已爽约';res.reason='签到到期，事件待复核';log('自动爽约');}}else if(res.state==='暂离中'&&res.leaveDeadline<res.e&&t>=res.leaveDeadline){res.state='异常关闭';res.reason='暂离超时，座位已释放';log('暂离超时');}else if(['使用中','暂离中'].includes(res.state)&&t>=res.e){res.state='已完成';res.reason='预约到期结束';log('到期结束');}}
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{current=b.dataset.tab;document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id===current));document.querySelectorAll('[data-tab]').forEach(x=>x.setAttribute('aria-selected',x===b));if(current==='stats')refreshStats();});
$('reset').onclick=()=>location.reload();$('query').onclick=()=>{say('座位状态已更新。');};
$('reserve').onclick=()=>{if(!userGuard())return;if(!$('agree').checked){say('请先阅读并勾选规则。',true);return;}if(res){say('已查询到本次提交的预约DEMO-R001，未重复创建。');return;}const day=$('day').value,s=dateMinute(day,$('start').value),e=dateMinute(day,$('end').value),range=bookingDates();
 if(!day||!Number.isFinite(s)||!Number.isFinite(e)){say('请选择完整的日期和起止时间。',true);return;}
 if(day<range.today||day>range.last){say('可预约今天及未来6天的座位，请重新选择日期。',true);return;}
 if(s<nowMin()){say('开始时间已过去，请选择当前时间之后的时段。',true);return;}
 if(e<=s){say('结束时间须晚于开始时间，预约不可跨午夜。',true);return;}
 if(e-s<30){say('每次预约至少30分钟。',true);return;}
 if(e-s>840){say('每日预约累计最多840分钟，请缩短本次时段。',true);return;}
 if(blockIntersects('A01',s,e)||$('race').checked){say('提交失败：该时段已停用或刚被其他用户预约。未创建新预约，请重新查询。',true);return;}
 const cutoff=Math.min(s+15,e),f=n=>String(n).padStart(2,'0');res={day:$('day').value,start:$('start').value,end:$('end').value,s,e,cutoff,deadline:clockText(cutoff),state:'待签到',reason:'—',checked:false};log('ST-01 创建DEMO-R001');say($('lost').checked?'响应暂未收到，请前往“我的预约”查看提交结果。':'预约成功：DEMO-R001；状态待签到。');};
$('cancel').onclick=()=>{if(!userGuard())return;expiry();if(!res||res.state!=='待签到'||nowMin()>=res.s){say('当前状态或时间不允许取消；数据保持。',true);return;}res.state='已取消';res.reason='本人取消，返还'+(res.e-res.s)+'分钟，仍计1次预约';log('ST-05 取消');say('取消成功，保留时段已释放。');};
$('signout').onclick=()=>{if(!userGuard())return;expiry();if(!res||!['使用中','暂离中'].includes(res.state)){say('当前状态不能主动签退；未重复结束。',true);return;}res.state='已完成';res.reason='主动签退，返还'+Math.max(0,Math.floor(res.e-nowMin()))+'分钟，仍计1次预约';log('ST-09 主动签退');say('签退成功，剩余时段已释放；旧预约不能复活。');};
const complaints=[];let complaintDraft=true,adminComplaintId=null;
$('complain').onclick=()=>{if(!userGuard()||!complaintDraft)return;const t=$('complaintText').value.trim();if(!t){say('请填写问题说明。',true);return;}complaint={id:'C'+String(complaints.length+1).padStart(3,'0'),type:$('complaintType').value,text:t,state:'待受理',reply:'',supplements:[]};complaints.push(complaint);complaintDraft=false;if(!adminComplaintId)adminComplaintId=complaint.id;render();say('投诉 '+complaint.id+' 已提交。');};
$('closeComplaint').onclick=()=>{if(!userGuard())return;if(!complaint||complaint.state!=='已答复'){say('仅已答复投诉允许确认关闭。',true);return;}complaint.state='已关闭';render();say('CT-05：投诉已关闭，记录保留。');};
$('saveReview').onclick=()=>{if(!userGuard())return;if(!res||res.state!=='已完成'||!res.checked){say('只有本人已签到且已完成的预约可以评价。',true);return;}const edits=review?review.edits+1:0;review={score:$('rating').value,text:$('reviewText').value,edits};render();say('已保存同一条评价，修改保留历史，不新增重复评价。');};
$('manualViolation').onclick=()=>{if(!adminGuard())return;if(!$('evidence').value.trim()){say('手动登记必须有现场事实和证据说明。',true);return;}if(manual!=='无'){say('同一演示事件已登记，不重复生成。');return;}manual='待复核';render();say('VT-01：手动事件进入待复核，不直接加入黑名单。');};
$('validateViolation').onclick=()=>{if(!adminGuard())return;if(manual!=='待复核'){say('当前没有待复核事件。',true);return;}manual='生效';render();say('VT-02：复核成立；限制仍须单独明确期限与范围。');};
function complaintGuard(){if(!adminGuard())return false;if($('isAccused').checked){say('回避要求：被投诉人不能处理本投诉，请转其他授权人员。',true);return false;}return true;}
$('acceptComplaint').onclick=()=>{if(!complaintGuard())return;const item=complaints.find(c=>c.id===adminComplaintId);if(!item||item.state!=='待受理'){say('没有待受理投诉。',true);return;}item.state='处理中';render();say('CT-02：已受理投诉。');};
$('replyComplaint').onclick=()=>{if(!complaintGuard())return;const item=complaints.find(c=>c.id===adminComplaintId);if(!item||item.state!=='处理中'||!$('reply').value.trim()){say('需要处理中投诉及完整答复依据。',true);return;}item.reply+=(item.reply?'；后续答复：':'')+$('reply').value.trim();item.state='已答复';$('reply').value='';render();say('CT-03：答复已保存，学生可以查看或补充。');};
function stamp(){return new Date().toLocaleTimeString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'});}
function refreshStats(){if(current!=='stats'||document.hidden)return;if($('role').value!=='M1'){$('refreshStatus').textContent='无此场地统计权限';document.querySelector('.metrics').classList.add('hidden');document.querySelector('.charts').classList.add('hidden');return;}document.querySelector('.metrics').classList.remove('hidden');if(inFlight){$('refreshStatus').textContent='正在更新…';return;}inFlight=true;const seq=++requestSeq,v=scopeVersion,room=$('statsRoom').value,delay=$('slow').checked?12000:300;$('refreshStatus').textContent='正在更新…';setTimeout(()=>{inFlight=false;if(v!==scopeVersion||seq!==requestSeq||$('role').value!=='M1'){if(current==='stats')refreshStats();return;}if($('offline').checked){$('refreshStatus').textContent=lastSuccess?'更新失败 · 显示上次数据':'更新失败 · 暂无数据';return;}lastSuccess=stamp();refreshCount++;$('denom').textContent=room==='R1'?'210':'0';$('numer').textContent=room==='R1'?'90':'0';$('usage').textContent=room==='R1'?'42.9%':'—';document.querySelector('.charts').classList.toggle('hidden',room!=='R1');$('refreshStatus').textContent='更新于 '+lastSuccess;},delay);}
$('refresh').onclick=refreshStats;$('statsRoom').onchange=()=>{scopeVersion++;lastSuccess='';document.querySelector('.charts').classList.add('hidden');$('denom').textContent='—';$('numer').textContent='—';$('usage').textContent='—';refreshStats();};$('role').onchange=()=>{scopeVersion++;if(current==='stats')refreshStats();};setInterval(refreshStats,10000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshStats();});render();
