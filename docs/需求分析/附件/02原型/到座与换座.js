// Local interaction model. Data is reset when the page reloads.
let selectedSeatId='A01',siteIssue=null,swapDraft=null,swapSerial=0,facilityRevision=1;
const swapResults=new Map();
let recommendationUpdatedAt=clockStr();
const seatInfo={},positions={W:[40,190],E:[760,480]},graphEdges=[];
const rowY=[120,265,410,555],aisleY=[190,335,480,615],colX=[200,320,480,600];
const corridorX=[120,400,680],levels=[120,190,265,335,410,480,555,615];
for(let c=0;c<3;c++)for(let k=0;k<levels.length;k++){
 const node='J'+c+'_'+k;positions[node]=[corridorX[c],levels[k]];
 if(k)graphEdges.push(['J'+c+'_'+(k-1),node]);
 if(k%2&&c)graphEdges.push(['J'+(c-1)+'_'+k,node]);
}
for(let r=0;r<4;r++)for(let c=0;c<4;c++){
 const id='A'+String(r*4+c+1).padStart(2,'0');
 positions[id]=[colX[c],rowY[r]];
 graphEdges.push(['J'+(c===0?0:c===3?2:1)+'_'+(r*2),id]);
 seatInfo[id]={power:['A06','A11'].includes(id)?'故障':'正常',window:r===0};
}
graphEdges.push(['W','J0_1'],['E','J2_5']);
function routeTo(target,origin=$('routeOrigin').value){
 if(!positions[target]||!positions[origin])return null;
 const dist=new Map([[origin,0]]),previous=new Map(),pending=new Set(Object.keys(positions));
 while(pending.size){
  let node=null,best=Infinity;
  for(const id of pending)if((dist.get(id)??Infinity)<best){node=id;best=dist.get(id);}
  if(node===null)return null;
  pending.delete(node);
  if(node===target){const path=[node];while(previous.has(path[0]))path.unshift(previous.get(path[0]));return path;}
  if(node.startsWith('A'))continue;
  for(const [a,b] of graphEdges){const next=a===node?b:b===node?a:null;if(!next||!pending.has(next))continue;
   const length=best+Math.hypot(positions[node][0]-positions[next][0],positions[node][1]-positions[next][1]);
   if(length<(dist.get(next)??Infinity)){dist.set(next,length);previous.set(next,node);}
  }
 }return null;
}
function pathLength(path){return path?path.slice(1).reduce((sum,p,i)=>sum+Math.hypot(positions[p][0]-positions[path[i]][0],positions[p][1]-positions[path[i]][1]),0):Infinity;}
function activeReservation(){return !!res&&['待签到','使用中','暂离中'].includes(res.state);}
function period(){return activeReservation()?{s:Math.max(res.s,nowMin()),e:res.e}:{s:dateMinute($('day').value,$('start').value),e:dateMinute($('day').value,$('end').value)};}
function availableSeat(seat,s,e){
 if(!Number.isFinite(s)||!Number.isFinite(e)||s>=e||seat==='A03'||blockIntersects(seat,s,e))return false;
 if(res&&(res.seat||'A01')===seat&&activeReservation()&&res.s<e&&s<res.e)return false;
 const other=seatBooking(seat);
 return !other||!['待签到','使用中','暂离中'].includes(other.state)||!(other.s<e&&s<other.e);
}
function candidates(mode='swap'){
 const {s,e}=mode==='book'?{s:dateMinute($('day').value,$('start').value),e:dateMinute($('day').value,$('end').value)}:period();
 const origin=mode==='book'?$('bookOrigin').value:$('routeOrigin').value;
 const power=$(mode==='book'?'bookNeedPower':'swapNeedPower').checked;
 return Object.keys(seatInfo).filter(id=>!(siteIssue&&siteIssue.state!=='已关闭'&&siteIssue.seat===id)&&availableSeat(id,s,e)&&routeTo(id,origin)&&(!power||seatInfo[id].power==='正常'))
 .sort((a,b)=>($('seatPreference').value==='window'?(Number(seatInfo[b].window)-Number(seatInfo[a].window)):pathLength(routeTo(a,origin))-pathLength(routeTo(b,origin)))||a.localeCompare(b));
}
function floorSVG(target=null,path=null){
 let svg='<svg viewBox="0 0 800 650" role="img" aria-label="四排十六座自习室，西入口在上部通道，东入口在下部通道"><defs><marker id="'+(target?'routeArrow':'bookingArrow')+'" markerWidth="14" markerHeight="14" refX="12" refY="7" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0L14 7L0 14Z" fill="#164ec5"/></marker></defs><rect x="40" y="30" width="720" height="600" rx="3" fill="#fafbfc" stroke="#52616c" stroke-width="2"/><path d="M140 48H660" stroke="#78929f" stroke-width="5"/><text x="400" y="78" text-anchor="middle" font-size="20" fill="#111">北侧窗边</text>';
 for(const [a,b] of graphEdges){if(a.startsWith('A')||b.startsWith('A'))continue;svg+='<line x1="'+positions[a][0]+'" y1="'+positions[a][1]+'" x2="'+positions[b][0]+'" y2="'+positions[b][1]+'" stroke="#e2e8ed" stroke-width="30"/>';}
 for(const [id,label] of [['W','西入口'],['E','东入口']]){const [x,y]=positions[id],dx=id==='W'?1:-1;svg+='<path d="M'+x+' '+(y-22)+'v44" stroke="#fafbfc" stroke-width="6"/><path d="M'+x+' '+(y-22)+'h'+(dx*30)+'v44h'+(-dx*30)+'M'+(x+dx*30)+' '+(y-22)+'L'+x+' '+(y-12)+'v34" fill="white" stroke="#111" stroke-width="2"/><text x="'+(id==='W'?85:715)+'" y="'+(y-40)+'" text-anchor="middle" font-size="20" fill="#000">'+label+'</text>';}
 if(path)svg+='<polyline points="'+path.map(id=>positions[id].join(',')).join(' ')+'" stroke="#164ec5" stroke-width="6" fill="none" stroke-linejoin="round" marker-end="url(#'+(target?'routeArrow':'bookingArrow')+')"/>';
 if(target){for(const id of Object.keys(seatInfo)){const [x,y]=positions[id],chosen=id===target;svg+='<rect x="'+(x-46)+'" y="'+(y-29)+'" width="92" height="58" rx="5" fill="'+(chosen?'#164ec5':'white')+'" stroke="#536673" stroke-width="2"/><text x="'+x+'" y="'+(y+7)+'" text-anchor="middle" font-size="22" fill="'+(chosen?'white':'#111')+'">'+id+'</text>';}
  if(path){const [x,y]=positions[path[0]];svg+='<circle cx="'+x+'" cy="'+y+'" r="8" fill="#164ec5"/><text x="'+(x===40?95:705)+'" y="'+(y+38)+'" text-anchor="middle" font-size="19" fill="#111">起点</text>';}
 }
 return svg+'</svg>';
}
function renderRoute(){
 const target=activeReservation()?res.seat:null,path=target?routeTo(target):null;
 $('guideTarget').textContent=target?'我的预约 · '+target+' · 图书馆二层':'暂无有效预约，请先预约座位。';
 $('routeCard').hidden=!target;
 $('routeMap').innerHTML=target?floorSVG(target,path):'';
 $('routeText').hidden=!target||!!path;
 $('routeText').textContent=target&&!path?'所选入口暂无开放路线，请选择另一入口或联系场地管理员。':'';
 $('scanToSignIn').disabled=!target||res.state!=='待签到';$('scanToSignIn').querySelector('span').textContent=res?.checked?'已签到':'扫码签到';
}
function renderCandidates(){
 recommendationUpdatedAt=clockStr();
 const preferred=candidates('book').slice(0,3);
 $('bookRecommendations').textContent=res?'已创建预约，请在“我的预约”查看。':preferred.length?'推荐 '+preferred.join('、')+' · '+($('seatPreference').value==='window'?'靠窗优先':'离'+($('bookOrigin').value==='W'?'西':'东')+'入口较近')+' · 更新 '+recommendationUpdatedAt:'没有符合当前条件的座位。请调整时段、入口或设施条件。';
 $('swapOptions').hidden=!siteIssue||!activeReservation();
 if(!siteIssue||!activeReservation()){$('candidateList').innerHTML='';return;}
 const {s,e}=period();$('candidatePeriod').textContent=fullTime(s)+' 至 '+fullTime(e)+' · 更新 '+recommendationUpdatedAt;
 const list=candidates();$('candidateList').innerHTML=list.length?list.map(id=>'<div class="candidate-row"><div><strong>'+id+'</strong><p>插座'+esc(seatInfo[id].power)+' · '+(seatInfo[id].window?'靠窗':'内侧')+' · 可用至 '+res.end+'</p></div><button class="secondary" data-candidate="'+id+'">查看换座方案</button></div>').join(''):'<p>暂无满足剩余时段与必要设施的替代座位。可继续等待管理员处理。</p>';
 document.querySelectorAll('[data-candidate]').forEach(b=>b.onclick=()=>{if(userGuard())prepareSwap(b.dataset.candidate);});
}
function renderSiteIssue(){
 $('problemBooking').textContent=res?'预约 DEMO-R001 · 当前座位 '+(res.seat||'A01')+' · '+res.start+'—'+res.end:'请先创建预约。';
 $('problemForm').hidden=!!siteIssue||!activeReservation();
 const body=siteIssue?'<div class="record-main"><strong>现场问题 I001 · '+esc(siteIssue.type)+'</strong><span class="status">'+siteIssue.state+'</span></div><p>发生座位：'+siteIssue.seat+' · 关联预约：DEMO-R001</p><p>'+esc(siteIssue.text)+'</p><ul class="issue-history">'+siteIssue.entries.map(e=>'<li>'+esc(e)+'</li>').join('')+'</ul>':'<p>暂无现场问题。</p>';
 $('occupancyFinding').hidden=siteIssue?.type!=='座位被占用'||siteIssue.state!=='处理中';
 $('siteIssueProgress').innerHTML=body;$('siteIssueAdmin').innerHTML=body;$('siteSupplementBox').hidden=siteIssue?.state!=='已答复';
 $('openRoute').hidden=!activeReservation();$('openProblem').hidden=!activeReservation();
}
function renderSeats(){
 const s=dateMinute($('day').value,$('start').value),e=dateMinute($('day').value,$('end').value),power=$('bookNeedPower').checked;
 const valid=id=>availableSeat(id,s,e)&&(!power||seatInfo[id].power==='正常')&&!!routeTo(id,$('bookOrigin').value);
 if(selected&&(!valid(selectedSeatId)||res)){selected=false;$('selectedSeat').textContent='未选择';$('seatAttributes').textContent='请选择可预约座位';}
 $('bookingMapBase').innerHTML=floorSVG();
 document.querySelectorAll('[data-seat]').forEach(btn=>{
  const id=btn.dataset.seat,ok=availableSeat(id,s,e),filtered=power&&seatInfo[id].power!=='正常',noRoute=!routeTo(id,$('bookOrigin').value),sel=selected&&id===selectedSeatId,blocked=id==='A03'||blockIntersects(id,s,e);
  const [x,y]=positions[id];btn.style.left=(x/8)+'%';btn.style.top=(y/6.5)+'%';
  btn.disabled=!!res||!valid(id);btn.classList.toggle('selected',sel&&!btn.disabled);btn.classList.toggle('blocked',blocked);btn.classList.toggle('filtered',filtered&&!blocked);btn.setAttribute('aria-pressed',String(sel&&!btn.disabled));
  const label=res&&res.seat===id?res.state:blocked?'停用':filtered?'插座'+seatInfo[id].power:!ok?'不可预约':noRoute?'无通路':sel?'已选择':'可预约';
  btn.querySelector('small').textContent=label;btn.title=id+' · '+label+' · 插座'+seatInfo[id].power;
 });
 $('adminSeats').innerHTML=Object.keys(seatInfo).map(id=>'<tr><td>'+id+'</td><td>插座'+seatInfo[id].power+'</td><td>'+(res?.seat===id?res.state:id==='A03'||blockActive(id)?'已停用':availableSeat(id,nowMin(),nowMin()+30)?'可预约':'不可预约')+'</td><td>'+(res?.seat===id?'DEMO-R001':'—')+'</td></tr>').join('');
 summary();$('reserve').disabled=!!res||!selected||!$('agree').checked;
}
const renderV24=render;render=function(){renderV24();renderSeats();renderRoute();renderSiteIssue();renderCandidates();$('openReview').hidden=!(res?.state==='已完成'&&res.checked);};
function chooseSeat(id){if(!userGuard()||document.querySelector('[data-seat="'+id+'"]').disabled)return;selected=true;selectedSeatId=id;$('selectedSeat').textContent=id;$('seatAttributes').textContent=(seatInfo[id].window?'靠窗':'内侧')+' · 插座'+seatInfo[id].power;render();}
document.querySelectorAll('[data-seat]').forEach(b=>b.onclick=()=>chooseSeat(b.dataset.seat));
$('reserve').onclick=()=>{
 if(!userGuard())return;if(!selected||!$('agree').checked){say('请选择座位并阅读预约规则。',true);return;}
 if(res){say('已存在本次演示预约，请在我的预约查看结果。');return;}
 const day=$('day').value,s=dateMinute(day,$('start').value),e=dateMinute(day,$('end').value),range=bookingDates();
 if(!day||!Number.isFinite(s)||!Number.isFinite(e)||day<range.today||day>range.last||s<nowMin()||e<=s||e-s<30||e-s>840||s<dateMinute(day,'08:00')||e>dateMinute(day,'22:00')){say('请选择今天至未来6天内08:00—22:00的开放时段。每次至少30分钟，开始时间不能早于当前时间。',true);return;}
 if(!availableSeat(selectedSeatId,s,e)||$('race').checked){say('该时段座位不可预约，请重新选择。',true);return;}
 if($('bookNeedPower').checked&&seatInfo[selectedSeatId].power!=='正常'){say('该座位不满足可用插座要求，请更换座位或在选座条件中明确调整。',true);return;}
 const cutoff=Math.min(s+15,e);res={seat:selectedSeatId,originalSeat:selectedSeatId,day,start:$('start').value,end:$('end').value,s,e,cutoff,deadline:clockText(cutoff),state:'待签到',reason:'—',checked:false,version:1,needPower:$('bookNeedPower').checked,segments:[{seat:selectedSeatId,start:s,end:e}],swaps:[]};
 log('创建预约 DEMO-R001 · '+selectedSeatId);say($('lost').checked?'响应暂未收到，可在我的预约查看结果。':'预约成功。');
 if(!$('lost').checked){$('successDetails').textContent='图书馆二层 · '+selectedSeatId+'\n'+day+' '+res.start+'—'+res.end;$('successDeadline').textContent='请在'+res.start+'至'+res.deadline+'之间完成签到。';$('bookingResult').showModal();}
};
$('openRoute').onclick=()=>{if(!userGuard()||!activeReservation())return;go('guide');render();};
$('openProblem').onclick=()=>{if(!userGuard())return;go('mine');$('problemCard').hidden=false;$('swapNeedPower').checked=!!res?.needPower;render();$('problemCard').scrollIntoView({block:'start'});};
document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>render()));
$('routeOrigin').onchange=()=>{swapDraft=null;renderRoute();renderCandidates();};
function openDeskScan(){
 if(!userGuard())return;
 $('scanBooking').textContent=res?'当前预约：'+res.seat+' · '+res.day+' '+res.start+'—'+res.end:'暂无本人预约';
 $('deskScanResult').hidden=true;$('deskScanResult').textContent='';$('scanGoMine').hidden=true;$('simulateDeskScan').textContent='模拟扫码';
 $('deskScan').showModal();
}
function scanMessage(text,success=false){const el=$('deskScanResult');el.hidden=false;el.classList.toggle('success',success);el.textContent=text;}
$('signin').onclick=openDeskScan;$('scanToSignIn').onclick=openDeskScan;
$('scanGoMine').onclick=()=>{$('deskScan').close();go('mine');};
$('simulateDeskScan').onclick=()=>{
 if(!userGuard()){scanMessage('只能为本人预约签到。');return;}
 const scene=$('scanScenario').value;
 if(scene==='camera'){scanMessage('无法调用相机，请检查相机权限后重试，或联系场地管理员协助。');return;}
 if(scene==='invalid'){scanMessage('二维码无效，请扫描座位桌面上的签到码，或联系场地管理员。');return;}
 if($('offline').checked){scanMessage('网络不可用，未提交签到。请恢复连接后重试；若临近截止，请联系场地管理员。');return;}
 if(!res){scanMessage('未找到本人预约，请先预约座位。');return;}
 const scanned=scene==='wrong'?(res.seat==='A02'?'A01':'A02'):res.seat;
 if(scanned!==res.seat){scanMessage('识别到 '+scanned+'，与当前预约 '+res.seat+' 不一致，未签到。请前往预约座位后再扫码。');return;}
 expiry();
 if(res.state==='使用中'&&res.checked){scanMessage('你已于 '+clockText(res.checkinAt)+' 在 '+res.seat+' 签到，无需重复签到。',true);$('scanGoMine').hidden=false;return;}
 if(res.state!=='待签到'){scanMessage('当前预约为“'+res.state+'”，不能签到。请查看我的预约；如有异议可联系场地管理员。');$('scanGoMine').hidden=false;return;}
 if(nowMin()<res.s){scanMessage('已识别 '+scanned+'。尚未到签到时间，请在 '+res.start+' 至 '+res.deadline+' 之间扫码签到。');return;}
 // The response timeout scenario deliberately leaves completion unconfirmed.
 if(scene==='timeout'){scanMessage('签到结果暂未确认，请先查看我的预约。若仍显示待签到，可再次扫码；同一预约不重复记录签到。');$('scanGoMine').hidden=false;return;}
 res.state='使用中';res.checked=true;res.checkinAt=nowMin();res.checkinMethod='桌面扫码';res.checkinSeat=scanned;res.reason='已扫描 '+scanned+' 桌面二维码签到';
 log('桌面扫码签到 · '+scanned);scanMessage('签到成功 · '+scanned+' · '+clockText(res.checkinAt)+'，当前状态：使用中。',true);$('scanGoMine').hidden=false;$('simulateDeskScan').textContent='再次模拟扫码';
};
for(const id of ['bookNeedPower','seatPreference','bookOrigin'])$(id).onchange=()=>{swapDraft=null;renderSeats();renderCandidates();};
$('swapNeedPower').onchange=()=>{swapDraft=null;renderCandidates();};
$('openReview').onclick=()=>{if(userGuard()&&res?.state==='已完成'&&res.checked){$('reviewBooking').textContent='预约 DEMO-R001 · '+res.day+' '+res.start+'—'+res.end+' · '+res.seat;$('reviewDialog').showModal();}};
$('submitSiteIssue').onclick=()=>{if(!userGuard())return;expiry();if(!activeReservation()){say('请从有效预约报告现场问题。',true);return;}if(siteIssue){say('已存在问题记录I001，请查看处理进度。');return;}const text=$('siteIssueText').value.trim();if(!text){say('请填写现场情况。',true);return;}siteIssue={seat:res.seat||'A01',type:$('siteIssueType').value,text,state:'待受理',entries:[clockStr()+' 已提交，等待管理员受理']};render();say('问题已提交。可以等待处理，或自主查看换座方案。');};
function prepareSwap(target){
 expiry();if(!res||!['待签到','使用中'].includes(res.state)){say('仅待签到或使用中的有效预约可以换座；暂离中请先返回。',true);return;}
 if(!siteIssue){say('请先从当前预约提交现场问题，或继续使用原座位。',true);$('problemCard').scrollIntoView();return;}
 if(!candidates().includes(target)){say('候选已变化，请重新查看。',true);renderCandidates();return;}
 swapDraft={key:'SWAP-'+(++swapSerial),target,source:res.seat,version:res.version,facilityRevision,needPower:$('swapNeedPower').checked};
 $('swapSummary').innerHTML='<p>原座位：<strong>'+res.seat+'</strong></p><p>目标座位：<strong>'+target+'</strong></p><p>结束时间保持 '+res.end+'，预约编号及签到截止保持。</p><p>必要条件：'+($('swapNeedPower').checked?'可用插座':'未要求插座')+'；目标插座'+seatInfo[target].power+'。</p>';
 $('confirmSwap').textContent='确认换到此座位';$('swapDialog').showModal();
}
$('cancelSwap').onclick=()=>{$('swapDialog').close();swapDraft=null;};
$('confirmSwap').onclick=()=>{
 if(!userGuard())return;const p=swapDraft;if(!p){say('条件已变化，请关闭对话框并重新选择。',true);return;}
 if(swapResults.has(p.key)){$('swapDialog').close();say('已查询到换座结果：当前座位 '+swapResults.get(p.key)+'，未重复提交。');render();return;}
 expiry();if(!res||!['待签到','使用中'].includes(res.state)||res.version!==p.version||res.seat!==p.source){say('原预约状态已变化，请重新查看。',true);return;}
 if(p.facilityRevision!==facilityRevision||p.needPower!==$('swapNeedPower').checked||!candidates().includes(p.target)||$('swapRace').checked){say('目标或条件已变化，换座未提交，原预约保留。',true);return;}
 if($('swapFail').checked){say('换座保存失败，原预约保留，请稍后重试。',true);return;}
 const cut=Math.max(nowMin(),res.s),old=res.seat;
 res.segments.at(-1).end=cut;res.segments.push({seat:p.target,start:cut,end:res.e});res.swaps.push({key:p.key,from:old,to:p.target,time:cut});res.seat=p.target;res.needPower=p.needPower;res.version++;res.reason='本人确认由 '+old+' 换至 '+p.target+'；原现场问题继续处理';swapResults.set(p.key,p.target);log('换座 '+old+' → '+p.target+'，原结束时间保持');
 if($('swapLost').checked){$('confirmSwap').textContent='查询本次换座结果';say('响应暂未收到，请查询本次换座结果。');}else{$('swapDialog').close();say('换座成功，已更新到座路线；原问题继续处理。');}
};
$('saveFacility').onclick=()=>{if(!adminGuard())return;const reason=$('facilityReason').value.trim();if(!reason){say('请填写核实说明。',true);return;}const seat=$('facilitySeat').value;seatInfo[seat].power=$('facilityState').value;facilityRevision++;$('facilityResult').textContent=seat+' 插座'+seatInfo[seat].power+' · '+reason+' · '+clockStr();log('核实设施：'+seat+' 插座'+seatInfo[seat].power);say('设施状态已更新，相关选座结果同步调整。');};
$('acceptSiteIssue').onclick=()=>{if(!complaintGuard())return;if(siteIssue?.state!=='待受理'){say('没有待受理现场问题。',true);return;}expiry();
 siteIssue.state='处理中';
 siteIssue.entries.push(clockStr()+' 管理员M1已受理');
 const acceptedAt=nowMin();
 if(siteIssue.type==='座位被占用' && res?.state==='待签到' && res.seat===siteIssue.seat && acceptedAt<res.cutoff){
   res.originalCutoff=res.cutoff;
   res.cutoff=Math.min(acceptedAt+30,res.e);
   res.deadline=clockText(res.cutoff);
   res.occupancyProtected=true;
   siteIssue.entries.push('可在'+res.deadline+'前换座或签到');
 }
 render();say('已受理现场问题。');};
$('replySiteIssue').onclick=()=>{if(!complaintGuard())return;const t=$('siteReply').value.trim();if(siteIssue?.state!=='处理中'||!t){say('需要处理中问题及完整处理结果。',true);return;}expiry();
 if(siteIssue.type==='座位被占用' && $('unfoundedOccupancy').checked && res?.occupancyProtected){
   res.occupancyProtected=false;
   res.cutoff=res.originalCutoff;
   res.deadline=clockText(res.cutoff);
   if(res.protectionExpired){
     res.state='已爽约';res.reason='占座报告不属实，爽约事件待复核';
   }else{
     expiry();
   }
   siteIssue.entries.push(clockStr()+' 已核实占座报告不属实，恢复原签到截止 '+res.deadline);
 }
 $('unfoundedOccupancy').checked=false;
 siteIssue.state='已答复';siteIssue.entries.push(clockStr()+' M1答复：'+t);render();say('处理结果已保存。');};
$('siteSupplement').onclick=()=>{if(!userGuard())return;const t=$('siteSupplementText').value.trim();if(siteIssue?.state!=='已答复'||!t){say('请填写补充说明。',true);return;}siteIssue.entries.push(clockStr()+' 学生补充：'+t);siteIssue.state='处理中';$('siteSupplementText').value='';render();};
$('siteClose').onclick=()=>{if(!userGuard()||siteIssue?.state!=='已答复')return;siteIssue.state='已关闭';siteIssue.entries.push(clockStr()+' 学生确认关闭');render();};
for(const id of ['start','end','day'])$(id).addEventListener('change',()=>{renderSeats();renderCandidates();});
render();
