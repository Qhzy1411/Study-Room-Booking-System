import { projectFile, outputDir, baseline } from './运行路径.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const { startTestServer, projectRoot } = await import(projectFile('tests/helpers/server.js'));
const { createApiClient, key, setClock } = await import(projectFile('tests/helpers/client.js'));
const { addDaysLocal } = await import(projectFile('server/time.js'));

const require = createRequire(path.join(projectRoot, 'package.json'));
const records = [];
const desktop = process.env.ORIGINAL_PROJECT || projectRoot;
function verify() {
  const manifest = JSON.parse(fs.readFileSync(baseline,'utf8').replace(/^\uFEFF/,''));
  const differences = [];
  const documentationVariants = [];
  // 原始交付 ZIP 与测试版本只有 README.md 的内容不同。
  const deliveryReadme = 'F623FD892AE33714C45D06DB2A3DF35348582F2FB6C53FC2E168518C525D9DD0';
  for (const {path:relative,sha256} of manifest)
    for (const base of new Set([projectRoot, desktop])) {
      const digest = createHash('sha256').update(fs.readFileSync(path.join(base, relative))).digest('hex').toUpperCase();
      if (digest === sha256) continue;
      if (relative === 'README.md' && digest === deliveryReadme) {
        documentationVariants.push({base, relative, sha256: digest});
      } else {
        differences.push({base, relative});
      }
    }
  return {filesPerProject:manifest.length,differences,documentationVariants};
}
const before = verify();
assert.deepEqual(before.differences, []);
const executablePath = [process.env.CHROME_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(x => x && fs.existsSync(x));
const browser = await require('playwright-core').chromium.launch({executablePath,headless:true});
const version = browser.version();
const started = new Date().toISOString();
const ok = res => { assert.ok(res.status>=200 && res.status<300,JSON.stringify(res.json)); return res.json; };
const opts = () => ({key:key()});
const fields = (pg,label,control) => pg.locator('div.field').filter({has:pg.getByText(label,{exact:true})}).locator(control);
const nav = (pg,name) => pg.locator('.nav a').filter({hasText:name}).click();
const tab = (pg,name) => pg.getByRole('tab',{name,exact:true}).click();
async function run(id, fn) {
  if (process.argv.length>2 && !process.argv.slice(2).includes(id)) return;
  let srv, db;
  const pages=[];
  try {
    srv=await startTestServer({env:{TICK_INTERVAL_MS:'600000'}});
    db=new DatabaseSync(srv.dbPath);
    async function client(user) { const c=createApiClient(srv.base); await c.login(user); return c; }
    async function page(user) {
      const pg=await browser.newPage(); pages.push(pg); pg.setDefaultTimeout(5500);
      await pg.goto(srv.base); await pg.locator('#login-username').fill(user);
      await pg.locator('#login-password').fill('123456'); await pg.locator('#login-password').press('Enter');
      await pg.locator('.nav a').first().waitFor(); return pg;
    }
    const [sys,m,a,b]=await Promise.all(['s1','m1','u01','u02'].map(client));
    const today=ok(await sys.get('/system/clock')).nowText.slice(0,10), day=addDaysLocal(today,1);
    await setClock(sys,today+' 08:00');
    const book=(c,seat='A01')=>c.post('/reservations',{roomId:'R1',seatId:'R1-'+seat,date:day,start:'10:00',end:'11:00'},opts());
    const scan=async r=>{const code=ok(await m.get('/admin/seats/R1-A01/qr')).text;return a.post('/reservations/'+r.id+'/checkin',{code},opts());};
    function check(part,expected,actual,evidence={}) {
      let matches=true;try{assert.deepEqual(actual,expected);}catch{matches=false;}
      records.push({id,part,status:matches?'matches_expected':'differs_from_expected',expected,actual,evidence});
    }
    await fn({sys,m,a,b,db,day,today,page,client,book,scan,check});
  } catch(e) { records.push({id,status:'test_error',error:String(e.stack)}); }
  finally {for(const pg of pages) await pg.close(); db?.close(); await srv?.close();}
  console.log(id,records.filter(r=>r.id===id).map(r=>r.status+(r.error?' '+r.error.slice(0,350):'')).join(', '));
}

await run('F02',async({a,b,m,book,day,check})=>{
  const r=ok(await book(a)).reservation;
  ok(await a.post('/reservations/'+r.id+'/site-issues',{type:'facility',description:'椅面松动，请现场核实'},opts()));
  const swapped=ok(await a.post('/reservations/'+r.id+'/swap',{targetSeatId:'R1-A04',expectedVersion:r.version},opts())).reservation;
  assert.equal(swapped.seatCode,'A04');
  const offer=ok(await b.get('/availability?roomId=R1&date='+day+'&start=10:00&end=11:00')).seats.find(s=>s.code==='A01');
  const second=await book(b);check('第二名学生预约原座',['available',201],[offer.state,second.status],{message:second.json.error?.message});
  if(second.status===201) ok(await b.post('/reservations/'+second.json.reservation.id+'/cancel',{},opts()));
  const stop={seatId:'R1-A01',immediate:false,startAt:day+' 10:00',endAt:day+' 11:00',reason:'维修旧座'};
  const preview=ok(await m.post('/admin/suspensions/preview',stop));
  ok(await m.post('/admin/suspensions',{...stop,cleared:false,impactHash:preview.impactHash},opts()));
  const final=ok(await a.get('/reservations/'+r.id)).reservation;
  check('停用旧座后的新预约',[false,'A04','pending'],[preview.affected.some(x=>x.id===r.id),final.seatCode,final.status],{reason:final.cancelReason});
});
await run('F03',async({page,db,check})=>{
  const pg=await page('m1');await nav(pg,'违约与限制');await tab(pg,'手动登记');
  await pg.getByRole('searchbox').fill('u01');await pg.getByRole('button',{name:/u01/i}).click();
  const note='巡查记录：二层遗留物品，已由值班员核实。';await pg.locator('textarea').fill(note);
  const count=()=>db.prepare('select count(*) n from violations where material=?').get(note).n;
  const initial=count();await pg.getByRole('button',{name:'登记待复核事件'}).click();
  await pg.locator('#toast-root .toast').last().waitFor();
  check('登记后新增待复核事件',1,count()-initial,{toast:await pg.locator('#toast-root').innerText()});
});
await run('F04',async({page,db,sys,a,book,scan,day,check})=>{
  const r=ok(await book(a)).reservation;await setClock(sys,day+' 10:01');ok(await scan(r));
  assert.equal(db.prepare('select status from reservations where id=?').get(r.id).status,'using');
  const pg=await page('m1');await nav(pg,'场地与资源');await tab(pg,'停用管理');
  await fields(pg,'目标座位','select').selectOption('R1-A01');await fields(pg,'停用原因','input').fill('桌架松动，现场清场检修');
  await fields(pg,'结束时间','input').fill(day+'T11:00');
  await pg.getByRole('button',{name:'预览影响'}).click();const clear=pg.getByRole('checkbox',{name:/现场已清空/});await clear.click();
  const submit=pg.getByRole('button',{name:'确认停用'});const enabled=await submit.isEnabled(),checked=await clear.isChecked();
  if(enabled){const response=pg.waitForResponse(r=>r.url().endsWith('/api/admin/suspensions')&&r.request().method()==='POST');await submit.click();await response;}
  check('清场后提交',[true,true,1],[checked,enabled,db.prepare('select count(*) n from suspensions where reason=?').get('桌架松动，现场清场检修').n],{seat:'A01'});
});
await run('F09-F10',async({a,m,sys,day,book,scan,check,page})=>{
  const r=ok(await book(a)).reservation;await setClock(sys,day+' 10:00');ok(await scan(r));
  await setClock(sys,day+' 11:01');ok(await a.get('/reservations/'+r.id));
  await setClock(sys,addDaysLocal(day,1)+' 12:00');
  const stats=async()=>ok(await m.get('/admin/stats?roomId=R1&date='+day+'&start=10:00&end=11:00'));
  const metric=x=>[x.availableSeatMinutes,x.usageMinutes,x.usageRate];
  const initial=await stats(), base=metric(initial.metrics);assert.deepEqual(base,[960,60,6.3]);
  check('同场地同时段柱图',base,metric(initial.rooms.find(x=>x.roomId==='R1')),{date:day,window:'10:00–11:00'});
  const pg=await page('m1');await nav(pg,'数据统计');await pg.waitForLoadState('networkidle');
  for(const [input,value] of [[pg.locator('.head-actions input[type=date]'),day],[fields(pg,'统计开始（可选）','input'),'10:00'],[fields(pg,'统计结束（可选）','input'),'11:00']]){
    await input.fill(value);await pg.waitForLoadState('networkidle');
  }
  await pg.getByText('6.3%',{exact:true}).first().waitFor();
  const bar=pg.locator('.chart-card').filter({hasText:'各自习室登记使用率'}).locator('svg text');
  const barLabels=(await bar.allTextContents()).filter(x=>x.endsWith('%'));
  check('浏览器卡片与同场地柱图',true,barLabels.includes('6.3%'),{card:'6.3%',barLabels});
  ok(await m.patch('/admin/seats/R1-A01',{archived:true,reason:'次日移除座位'}));check('归档后重看昨日',base,metric((await stats()).metrics));
  ok(await m.patch('/admin/seats/R1-A01',{archived:false,reason:'恢复测试对照'}));assert.deepEqual(metric((await stats()).metrics),base);
  ok(await m.post('/admin/seats',{roomId:'R1',code:'Z99'}));check('新增后重看昨日',base,metric((await stats()).metrics));
});
await run('F11',async({page,db,check})=>{
  const pg=await page('u03');await nav(pg,'投诉与申诉');
  await pg.waitForLoadState('networkidle');await pg.getByRole('button',{name:'发起新投诉'}).click();
  const type=fields(pg,'问题类型','select');await type.selectOption('appeal');
  const vid=db.prepare("select id from violations where user_id='U03' and decided_by='M1' and status='effective' limit 1").get().id;
  await fields(pg,'关联违规记录','select').selectOption(vid);await type.selectOption('facility');
  const note='二层桌面损坏，申请检修。';await pg.locator('textarea').fill(note);
  const response=pg.waitForResponse(r=>r.url().endsWith('/api/complaints')&&r.request().method()==='POST');
  await pg.getByRole('button',{name:'提交投诉'}).click();assert.equal((await response).status(),201);
  const row=db.prepare('select type,violation_id,accused_id from complaints where description=?').get(note);
  check('普通设施投诉关联记录',['facility',null,null],[row.type,row.violation_id,row.accused_id],{selectedBeforeTypeChange:vid});
});
await run('F12',async({a,book,check})=>{
  const r=ok(await book(a)).reservation;
  const c=ok(await a.post('/complaints',{roomId:'R1',type:'service',description:'咨询值班时间，关联本人预约',reservationId:r.id},opts())).complaint;
  const url='/reservations/'+r.id;
  const ordinary=ok(await a.get(url+'/site-issues')).issues, detail=ok(await a.get(url)).reservation;
  check('普通投诉进入现场进度',[false,false],[ordinary.some(x=>x.id===c.id),detail.siteIssues.some(x=>x.id===c.id)],{ordinaryComplaint:c.id});
});
await run('F21-F23',async({page,a,book,day,check})=>{
  const r=ok(await book(a)).reservation;
  const pg=await page('u01');await nav(pg,'投诉与申诉');await pg.waitForLoadState('networkidle');
  await pg.getByRole('button',{name:'发起新投诉'}).click();
  await fields(pg,'相关场地','select').selectOption('R2');
  const options=fields(pg,'关联预约（可选）','select');
  const offered=await options.locator('option').evaluateAll((all,id)=>all.some(x=>x.value===id),r.id);
  if(offered) {
    await options.selectOption(r.id);await pg.locator('textarea').fill('咨询本人预约的自习室开放时间');
    const reply=pg.waitForResponse(r=>r.url().endsWith('/api/complaints')&&r.request().method()==='POST');
    await pg.getByRole('button',{name:'提交投诉'}).click();const resp=await reply;
    check('场地选择与本人的预约匹配',false,true,{status:resp.status(),message:(await resp.json()).error?.message});
  } else check('场地选择与本人的预约匹配',false,false);
  await nav(pg,'预约座位');await fields(pg,'日期','select').selectOption(day);
  const time=pg.locator('input[type=time]');await time.nth(1).fill('15:00');await time.first().fill('14:00');
  await pg.getByRole('button',{name:/查询座位/}).click();await pg.waitForLoadState('networkidle');
  const saved=await pg.evaluate(()=>JSON.parse(localStorage.getItem('srb.bookFilters')));
  assert.deepEqual([saved.start,saved.end],['14:00','15:00']);
  await nav(pg,'我的预约');await nav(pg,'预约座位');
  check('返回预约页的原筛选时段',['14:00','15:00'],[await time.first().inputValue(),await time.nth(1).inputValue()]);
});
await run('F13',async({sys,page,db,check})=>{
  ok(await sys.post('/admin/users',{username:'two_rooms',displayName:'两馆值班员',password:'123456',role:'venue_admin',grants:['R1','R2']}));
  db.prepare("update evaluations set content='二层走查标记' where room_id='R1'").run();
  db.prepare("update evaluations set content='三层走查标记' where room_id='R2'").run();
  const counts=Object.fromEntries(['R1','R2'].map(id=>[id,db.prepare('select count(*) n from evaluations where room_id=?').get(id).n]));
  assert.ok(counts.R1>0);
  const pg=await page('two_rooms');await nav(pg,'场地与资源');
  const room=pg.locator('.page-head .head-actions select');
  async function switchTo(id) {
    if(await room.inputValue()===id) return;
    const done=pg.waitForResponse(r=>new URL(r.url()).pathname==='/api/admin/rooms/'+id);
    await room.selectOption(id);assert.equal((await done).status(),200);
    await pg.waitForLoadState('networkidle');await pg.waitForTimeout(750);
  }
  for(const [name,ready] of [['桌面二维码','.qr-item'],['现场预约','table.data, .empty'],['评价管理','table.data']]){
    await tab(pg,'座位与设施');await switchTo('R1');await tab(pg,name);await pg.locator(ready).first().waitFor();
    const requests=[];const record=req=>{const url=new URL(req.url());if(url.pathname.startsWith('/api/admin/'))requests.push(url.pathname+url.search);};
    pg.on('request',record);await switchTo('R2');pg.off('request',record);
    const body=await pg.locator('body').innerText();
    const stale=name==='评价管理'?body.includes('二层走查标记'):body.includes(name==='桌面二维码'?'正在加载座位二维码':'正在加载…');
    await tab(pg,'座位与设施');await tab(pg,name);
    if(name==='桌面二维码')await pg.locator('.qr-item').first().waitFor();
    if(name==='现场预约')await pg.locator('table.data, .empty').first().waitFor();
    if(name==='评价管理')await pg.getByText(counts.R2?'三层走查标记':'该场地暂无评价',{exact:true}).first().waitFor();
    check(name,false,stale,{room:'R2',requests,afterReenter:'目标页已加载',evaluationCounts:counts});
  }
});
await run('F18-F19',async({sys,page,m,check})=>{
  const pg=await page('m1');await nav(pg,'场地与资源');await tab(pg,'座位与设施');
  await pg.locator('table.data').first().waitFor();
  const controls=[...new Set(await pg.getByRole('button').allTextContents())];
  ok(await m.post('/admin/seats',{roomId:'R1',code:'Z99'}));
  await pg.locator('.head-actions').getByRole('button',{name:'刷新'}).click();
  await pg.getByText('Z99',{exact:true}).first().waitFor();
  check('维护页新增座位入口',true,controls.some(x=>/新增座位|添加座位|新建座位/.test(x)),{controls,addedThroughAdminService:'Z99'});
  const user=(ok(await sys.get('/admin/users')).users).find(x=>x.username==='s1');assert.equal(user.canReview ?? user.permissions?.canReview,true);
  const sp=await page('s1');const links=await sp.locator('.nav a').allTextContents();
  check('已获业务复核授权账号的违约复核入口',true,links.some(x=>x.includes('违约与限制')),{links,canReview:true});
});
await run('F08',async({sys,db,check})=>{
  const active=()=>db.prepare("select count(*) n from sessions where user_id='U02' and expires_at>?").get(Date.now()).n;
  const previous=active();assert.ok(previous>0);
  ok(await sys.patch('/admin/users/U02',{password:'review2026!',reason:'合成账号重置口令'}));
  const after=active();check('管理员重置后存续的会话记录',0,after,{before:previous,method:'仅计数，未使用原会话访问'});
});
for(const queued of [0,200]){
  for(const withKey of [true,false]){
    await run('F01-'+queued+'-'+(withKey?'with-key':'no-key'),async({m,a,sys,day,db,book,check})=>{
      const reservation=ok(await book(a)).reservation;
      const base=db.prepare('select * from reservations where id=?').get(reservation.id);
      const code=ok(await m.get('/admin/seats/R1-A01/qr')).text;
      await setClock(sys,day+' 10:14');ok(await a.get('/reservations/'+reservation.id));
      // 目标预约通过正常业务创建；积压组另置 200 条到期记录。
      const add=db.prepare('insert into reservations(id,user_id,room_id,seat_id,start_ts,end_ts,status,rule_version_id,created_at,checkin_deadline) values(?,?,?,?,?,?,?,?,?,?)');
      for(let i=0;i<queued;i++){
        const offset=(queued-i+3)*86400000;
        add.run('QUEUE-'+i,base.user_id,base.room_id,base.seat_id,base.start_ts-offset,base.end_ts-offset,'pending',base.rule_version_id,base.created_at-offset,base.checkin_deadline-offset);
      }
      const id=reservation.id;await setClock(sys,day+' 10:16');
      const ahead=db.prepare("select count(*) n from reservations where status='pending' and checkin_deadline<?").get(base.checkin_deadline).n;
      assert.equal(ahead,queued);
      const response=await a.post('/reservations/'+id+'/checkin',{code},withKey?opts():{});
      const read=()=>[db.prepare('select status from reservations where id=?').get(id).status,
        db.prepare('select count(*) n from violations where reservation_id=?').get(id).n,
        db.prepare("select count(*) n from audits where object_id=? and action='reservation.no_show'").get(id).n];
      const immediate=read();ok(await a.get('/reservations/'+id));const afterRead=read();
      check('逾期签到应与落库状态一致',[409,'no_show',1,1],[response.status,...immediate],{earlierDue:ahead,withKey,message:response.json.error?.message,afterSubsequentRead:afterRead});
    });
  }
}
await browser.close();
const after=verify();
const out={started,finished:new Date().toISOString(),node:process.version,browser:version,before,after,records};
const file=process.env.BUSINESS_RERUN === '1' ? '第四轮业务重跑结果.json' : (process.argv.length>2 ? '第三轮选测结果.json' : '第三轮组员问题复测结果.json');
fs.writeFileSync(path.join(outputDir,file),JSON.stringify(out,null,2)+'\n');
if(records.some(r=>r.status==='test_error')||after.differences.length) process.exitCode=2;
