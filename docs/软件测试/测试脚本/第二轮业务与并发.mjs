import path from 'node:path';
import { projectFile, outputDir } from './运行路径.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
const {startTestServer} = await import(projectFile('tests/helpers/server.js'));
const {createApiClient,key,setClock} = await import(projectFile('tests/helpers/client.js'));
const {addDaysLocal,at} = await import(projectFile('server/time.js'));
const require=createRequire(projectFile('package.json'));
const out={timestamp:new Date(),node:process.version,checks:[],rounds:[],errors:[]};
const rules={advanceDays:7,checkinGraceMin:15,awayMinutes:15,minMinutes:30,dailyCount:4,dailyMinutes:240};
function ok(r,status=200){assert.equal(r.status,status,JSON.stringify(r.json));return r.json}
function check(id,expected,actual,details={}) {
  let pass=true;
  try{assert.deepEqual(actual,expected)}catch{pass=false}
  out.checks.push({id,expected,actual,pass,details});console.log(id,pass?'PASS':'FAIL',JSON.stringify(actual));
}
async function fixture(label,fn){
  let s,db;
  try{
    s=await startTestServer();db=new DatabaseSync(s.dbPath,{readOnly:true});
    const login=async n=>{const c=createApiClient(s.base);await c.login(n);return c};
    const [sys,m,a,b]=await Promise.all(['s1','m1','u01','u02'].map(login));
    const today=ok(await sys.get('/system/clock')).nowText.slice(0,10);
    await setClock(sys,today+' 07:30');
    await fn({sys,m,a,b,today,date:addDaysLocal(today,1),db,login,base:s.base});
  }catch(e){out.errors.push({label,error:String(e.stack)});console.error(label,String(e))}
  finally{db?.close();await s?.close()}
}
const book=(c,date,code,start,end,options={},k=key())=>c.post('/reservations',{roomId:'R1',seatId:'R1-'+code,date,start,end,...options},{key:k});
const availability=async(c,date,start,end)=>ok(await c.get('/availability?'+new URLSearchParams({roomId:'R1',date,start,end})));
const rule=(sys,options)=>sys.post('/admin/rules',{...rules,...options,note:'独立测试库内的对照规则'});
const op=(c,r,action,body={})=>c.post('/reservations/'+r.id+'/'+action,body,{key:key()});
async function report(c,r){ok(await op(c,r,'site-issues',{type:'facility',description:'现场遇到座椅故障，申请换座。'}),201)}
async function barrier(jobs){
  let release;
  const gate=new Promise(resolve=>{release=resolve});
  const waiting=jobs.map(async job=>{await gate;return job()});
  release();return Promise.all(waiting);
}
await fixture('全日自习、取消改期与提前签退',async({a,b,sys,m,date,today})=>{
  const full=await book(a,date,'A01','08:00','22:00');
  check('R01 当前默认规则',422,full.status,{message:full.json.error?.message});
  const r=ok(await book(a,date,'A01','08:00','12:00'),201).reservation;
  ok(await op(a,r,'cancel'));
  const freed=(await availability(b,date,'08:00','12:00')).seats.find(s=>s.code==='A01').state;
  const next=await book(a,date,'A02','14:00','15:00');
  const q=(await availability(a,date,'14:00','15:00')).quota;
  check('R02 提前一天取消后改订',[422,240,0,'available'],[next.status,q.usedMinutes,q.remainingMinutes,freed],{message:next.json.error?.message});
  const original=ok(await book(b,date,'A01','08:00','12:00'),201).reservation;
  await setClock(sys,date+' 08:00');
  ok(await op(b,original,'checkin',{code:ok(await m.get('/admin/seats/R1-A01/qr')).text}));
  await setClock(sys,date+' 08:30');ok(await op(b,original,'checkout'));
  const evening=await book(b,date,'A01','19:00','20:00');
  const q2=(await availability(b,date,'19:00','20:00')).quota;
  check('R03 使用半小时后签退',[422,240],[evening.status,q2.usedMinutes],{message:evening.json.error?.message});
  const nextDay=addDaysLocal(date,1);
  ok(await rule(sys,{dailyMinutes:840}),201);
  const long=await book(a,nextDay,'A01','08:00','22:00');
  check('R04 仅在测试库调至840分钟',[201,840],[long.status,long.json.quota?.usedMinutes],{rule:long.json.ruleVersion?.id,date:nextDay});
});
await fixture('换座页面保留插座要求',async({a,m,date,base})=>{
  const r=ok(await book(a,date,'A01','10:00','12:00',{needPower:true}),201).reservation;
  await report(a,r);
  const checked=ok(await a.get('/reservations/'+r.id+'/swap-candidates?needPower=true'));
  assert(!checked.candidates.some(s=>s.power==='faulty'));
  const chrome=[process.env.CHROME_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p=>p&&fs.existsSync(p));
  assert.ok(chrome,'需要 Chrome 或 Edge');
  const browser=await require('playwright-core').chromium.launch({executablePath:chrome,headless:true});
  try{
    const page=await browser.newPage();
    await page.goto(base);await page.locator('.demo-btns button').first().click();
    await page.locator('.nav a').filter({hasText:'我的预约'}).first().click();
    await page.locator('article.record').filter({hasText:r.startText}).filter({hasText:'A01'}).first().getByRole('button',{name:'座位遇到问题'}).click();
    const need=page.getByRole('checkbox',{name:'必须插座正常'});
    await need.waitFor();
    const faulty=page.locator('.recommend').filter({hasText:'插座故障'});
    const codes=await faulty.locator('.name').allTextContents();
    check('U01 换座沿用已选必要条件',[true,0],[await need.isChecked(),codes.length],{reservation:r.id,faultyCandidates:codes});
    if(codes.length){
      await faulty.first().getByRole('button',{name:'换到此座位'}).click();
      const ack=page.getByRole('button',{name:'确认换座',exact:true});
      const result=page.waitForResponse(resp=>resp.request().method()==='POST'&&resp.url().endsWith('/swap'));
      await ack.click();const resp=await result;
      const current=ok(await a.get('/reservations/'+r.id)).reservation;
      check('U02 未放宽条件时确认故障座位',false,resp.ok()&&current.seatCode===codes[0],{status:resp.status(),seat:current.seatCode});
    }
  }finally{await browser.close()}
});
await fixture('多人抢座',async({sys,m,db,login,today})=>{
  // 单独提高额度，排除“达到日上限”干扰互斥判断。每轮换一个全新的预约日期。
  ok(await rule(sys,{dailyCount:20,dailyMinutes:1440}),201);
  const clients=[];
  for(let i=0;i<20;i++){
    const username='qa'+String(i).padStart(2,'0');
    ok(await sys.post('/admin/users',{username,displayName:'测试学生'+i,password:'123456',role:'student'}),201);
    clients.push(await login(username));
  }
  for(const [from,to] of [[1,31],[32,50]])ok(await m.post('/admin/rooms/R1/plans',{dateFrom:addDaysLocal(today,from),dateTo:addDaysLocal(today,to),start:'08:00',end:'22:00'}));
  const patterns=[
    ['相同','A01',[['09:00','10:00']],1],
    ['部分重叠','A02',[['10:00','11:00'],['10:30','11:30']],1],
    ['完全包含','A03',[['12:00','13:30'],['12:30','13:00']],1],
    ['首尾相邻','A04',[['14:00','15:00'],['15:00','16:00']],2],
    ['链式重叠','A05',[['17:00','18:00'],['17:30','18:30'],['18:00','19:00']],null]
  ];
  for(let n=1;n<=50;n++){
    const date=addDaysLocal(today,n);
    await setClock(sys,date+' 07:00');
    for(const [shape,seat,windows,wins] of patterns){
      const requests=clients.map((_,i)=>({key:key(),user:'qa'+String(i).padStart(2,'0'),interval:windows[(i+n)%windows.length]}));
      const responses=await barrier(clients.map((c,i)=>()=>book(c,date,seat,...requests[i].interval,{},requests[i].key)));
      const rows=db.prepare("SELECT r.id,s.start_ts,s.end_ts FROM reservation_segments s JOIN reservations r ON r.id=s.reservation_id WHERE s.seat_id=? AND s.start_ts>=? AND s.start_ts<? AND r.status='pending' ORDER BY s.start_ts").all('R1-'+seat,at(date,'08:00'),at(date,'22:00'));
      const winners=responses.filter(v=>v.status===201).map(v=>v.json.reservation.id);
      const onlyExpected=responses.every(v=>v.status===201||(v.status===409&&v.json.error.message.includes('座位')));
      const exactIds=JSON.stringify(rows.map(r=>r.id).sort())===JSON.stringify(winners.slice().sort());
      const noOverlap=rows.every((r,i)=>i===0||rows[i-1].end_ts<=r.start_ts);
      const maximal=windows.every(([a,b])=>rows.some(r=>at(date,a)<r.end_ts && r.start_ts<at(date,b)));
      const pass=onlyExpected&&exactIds&&noOverlap&&maximal&&(wins===null||winners.length===wins);
      out.rounds.push({round:n,date,shape,seat,pass,rows,requests:requests.map((r,i)=>({...r,status:responses[i].status,id:responses[i].json.reservation?.id}))});
    }
    if(n%10===0) console.log('已完成',n,'轮');
  }
  for(const [shape] of patterns){
    const batch=out.rounds.filter(r=>r.shape===shape);
    check('C-'+shape,50,batch.filter(r=>r.pass).length,{requests:batch.length*20});
  }
});
await fixture('重复提交、本人时段与换座竞争',async({sys,m,a,b,db,date})=>{
  const k=key();
  const same=await barrier(Array.from({length:20},()=>()=>book(a,date,'A01','10:00','11:00',{},k)));
  const r=ok(same[0],201).reservation;
  const identifiers=new Set(same.map(x=>x.json.reservation?.id));
  const count=(sql,...params)=>db.prepare(sql).get(...params).n;
  check('C-同键重试',[20,1,1,1,1],[same.filter(x=>x.status===201).length,identifiers.size,
    count('SELECT COUNT(*) n FROM reservation_segments WHERE reservation_id=?',r.id),
    count("SELECT COUNT(*) n FROM audits WHERE object_id=? AND action='reservation.create'",r.id),
    count('SELECT COUNT(*) n FROM notifications WHERE event_key=?','reservation.created:'+r.id)]);
  const competing=await barrier(['A02','A03'].map(s=>()=>book(b,date,s,'10:00','11:00')));
  const rb=competing.find(x=>x.status===201)?.json.reservation;
  check('C-同人两座',[201,409,1],[...competing.map(v=>v.status).sort(),count("SELECT COUNT(*) n FROM reservations WHERE user_id='U02' AND start_ts=? AND status='pending'",at(date,'10:00'))]);
  assert.ok(rb);await report(a,r);await report(b,rb);
  const owners=[[a,r],[b,rb]];
  const swaps=await barrier(owners.map(([c,o])=>()=>op(c,o,'swap',{targetSeatId:'R1-A04',expectedVersion:o.version})));
  const current=await Promise.all(owners.map(async([c,o])=>ok(await c.get('/reservations/'+o.id)).reservation));
  check('C-争换同座',[true,true,1],[JSON.stringify(swaps.map(x=>x.status).sort())==='[200,409]',
    current.every((v,i)=>v.status==='pending'&&v.seatCode===(swaps[i].status===200?'A04':owners[i][1].seatCode)),
    count("SELECT COUNT(*) n FROM seat_changes WHERE to_seat_id='R1-A04' AND reservation_id IN (?,?)",r.id,rb.id)],{statuses:swaps.map(v=>v.status),finalSeats:current.map(v=>v.seatCode)});
});
await fixture('签到截止与已受理的现场问题',async({a,m,sys,date,db})=>{
  const r=ok(await book(a,date,'A01','10:00','12:00'),201).reservation;
  await setClock(sys,date+' 10:02');
  const issue=ok(await op(a,r,'site-issues',{type:'service',description:'我已到场，预约的座位被占用，请工作人员协助。'}),201).complaint;
  await setClock(sys,date+' 10:05');
  ok(await m.post('/admin/complaints/'+issue.id+'/accept'));
  const before=ok(await a.get('/reservations/'+r.id+'/swap-candidates')).candidates.length;
  await setClock(sys,date+' 10:16');
  const current=ok(await a.get('/reservations/'+r.id)).reservation;
  const status=ok(await a.get('/reservations/'+r.id+'/site-issues')).issues.find(v=>v.id===issue.id).status;
  const candidates=await a.get('/reservations/'+r.id+'/swap-candidates');
  const events=db.prepare('SELECT type,status FROM violations WHERE reservation_id=?').all(r.id);
  check('R05 等待处理跨过签到截止',['processing','no_show',true,409,'pending'],[status,current.status,before>0,candidates.status,events[0]?.status],
    {id:r.id,issue:issue.id,deadline:r.checkinDeadlineText,before,events,message:candidates.json.error?.message});
});
await fixture('最后30分钟额度并发',async({a,date,db})=>{
  ok(await book(a,date,'A01','08:00','11:30'),201);
  const attempts=await barrier([['A02','13:00','13:30'],['A03','14:00','14:30']].map(([seat,start,end])=>()=>book(a,date,seat,start,end)));
  const spent=db.prepare("SELECT sum((end_ts-start_ts)/60000) mins FROM reservations WHERE user_id='U01' AND start_ts>=? AND start_ts<?").get(at(date,'08:00'),at(date,'22:00')).mins;
  check('C-余额竞争',[201,422,240],[...attempts.map(v=>v.status).sort(),spent],{messages:attempts.map(v=>v.json.error?.message||'创建成功')});
});
fs.writeFileSync(path.join(outputDir,'第二轮业务与并发结果.json'),JSON.stringify(out));
process.exitCode=out.errors.length?2:out.checks.some(r=>!r.pass)||out.rounds.some(r=>!r.pass)?1:0;
